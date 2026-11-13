// L723 : la branche cible avance pendant la porte (un autre run s'intègre) : le run se rebase seul, rejoue la porte, puis avance rapide.
// Vécu 2 fois le 13-11 (L687 après L707, correctif du HUD après L689) : « refus-integration », repris à la main par --reponse.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { executerRun, type Etat } from '../src/run/run.js';
import { MARQUEUR } from '../src/rapport.js';
import { commite, depot, fauxClaude, git, horloge, io, sortie } from './run-outils.js';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
/** Porte qui compte ses passages dans `compte` et joue `pendant` (une commande shell) à chaque passage, comme un autre run qui s'intègre pendant elle. */
function porte(repo: string, pendant: string): string {
  const compte = join(repo, '..', 'porte.compte');
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: test -f fait.txt && echo x >> ${compte} && ${pendant}\n`);
  git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'porte');
  return compte;
}
const passages = (compte: string) => (existsSync(compte) ? readFileSync(compte, 'utf8').split('\n').filter(Boolean).length : 0);
/** Faux claude dont chaque session rend son propre dernier message (`reponses`), comme un vrai rapport de travail puis une réponse de résolution. */
const parlant = (exec: Executeur, reponses: string[]): Executeur => (args, o) => {
  const r = exec(args, o), j = JSON.parse(r.stdout);
  if (r.code) return r; // une fin de quota garde son texte
  return { ...r, stdout: sortie(j.session_id, reponses.shift() ?? j.result) };
};
const HEBDO = "You've hit your weekly limit · resets Thu 9am (Europe/Paris)";
const RAPPORT = `${MARQUEUR}\nfini. Commit : ajoute fait.txt. Vérifié : porte verte. Non vérifié : la capture.`; // L728 : le rapport commence par le marqueur, comme le brief le demande
const RESOLUTION = 'fini : fait.txt garde les deux versions, rebase terminé.';
/** La session de travail commite fait.txt pendant qu'« ailleurs » commite un autre fait.txt sur main : le rebase est en conflit sur fait.txt. */
const travailEnConflit = (repo: string) => (cwd: string) => {
  commite('fait.txt')(cwd); writeFileSync(join(repo, 'fait.txt'), 'autre'); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'fait.txt ailleurs');
};
const resout = (cwd: string) => { writeFileSync(join(cwd, 'fait.txt'), 'les deux'); git(cwd, 'add', 'fait.txt'); git(cwd, ...ID, '-c', 'core.editor=true', 'rebase', '--continue'); };
const rebaseEnCours = (wt: string) => ['rebase-merge', 'rebase-apply'].some((d) => existsSync(join(wt, git(wt, 'rev-parse', '--git-path', d))));

describe('cadence run : la branche cible avance pendant la porte (L723)', () => {
  it('deux runs : le premier s\'intègre pendant la porte du second ; le second se rebase, rejoue la porte et intègre', () => {
    const repo = depot();
    // Le premier run : sa branche, partie de la même base, qu'il intègre en avance rapide (comme suite() de run.ts) pendant la porte du second.
    const compte = porte(repo, `git -C ${repo} merge -q --ff-only cadence/run-premier`);
    git(repo, 'checkout', '-qb', 'cadence/run-premier'); writeFileSync(join(repo, 'premier.txt'), 'ok'); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'ajoute premier.txt');
    git(repo, 'checkout', '-q', 'main');
    const { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([commite('fait.txt')]), out });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s', '-3')).toBe('ajoute fait.txt\najoute premier.txt\nporte');
    expect(passages(compte)).toBe(2); // porte rejouée sur le résultat rebasé
    expect(l.join('\n')).toMatch(/main a avancé pendant la porte : rebase et porte rejouée/);
    expect(existsSync(e.worktree)).toBe(false);
  });

  it('conflit au rebase : la même session le résout avec la liste des fichiers, la porte est rejouée, puis intégration', () => {
    const repo = depot(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec = fauxClaude([travailEnConflit(repo), resout], appels);
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out: () => {} });
    expect(e.etat).toBe('integre');
    const prompt = appels[1].args[appels[1].args.indexOf('-p') + 1];
    expect(appels[1].args).toEqual(expect.arrayContaining(['--resume', 's1']));
    expect(prompt).toMatch(/conflit[\s\S]*fait\.txt[\s\S]*rebase --continue/);
    expect(readFileSync(join(repo, 'fait.txt'), 'utf8')).toBe('les deux');
  });

  it('conflit que la session ne résout pas : rendu au lead (« conflit »), rebase annulé, fichiers nommés', () => {
    const repo = depot(), base = () => git(repo, 'rev-parse', 'HEAD');
    const exec = parlant(fauxClaude([travailEnConflit(repo), () => {}]), [RAPPORT, 'je n\'y arrive pas']);
    const avant = base();
    const e = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e.etat).toBe('conflit');
    expect(e.rapport).toBe(RAPPORT); // la réponse de la résolution ne remplace pas le rapport du travail
    expect(e.conflits).toEqual([expect.objectContaining({ cible: 'main', fichiers: ['fait.txt'], resolu: false, message: 'je n\'y arrive pas' })]);
    expect(e.detail).toMatch(/fait\.txt/);
    expect(e.detail).toMatch(/pas résolu/);
    expect(rebaseEnCours(e.worktree)).toBe(false);
    expect(base()).not.toBe(avant); // seul le commit d'« ailleurs » est sur main
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('fait.txt ailleurs');
  });

  it('run complet avec conflit résolu : rapport du travail intact, conflit visible dans l\'état (fichiers, sha, ce que la session a dit) et au journal', () => {
    const repo = depot(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: parlant(fauxClaude([travailEnConflit(repo), resout]), [RAPPORT, RESOLUTION]), out });
    const etat = JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat, journal = l.join('\n'), ailleurs = git(repo, 'rev-parse', 'HEAD~1');
    expect(etat.etat).toBe('integre');
    expect(etat.rapport).toBe(RAPPORT);
    expect(etat.conflits).toEqual([{ cible: 'main', sur: ailleurs, fichiers: ['fait.txt'], resolu: true, message: RESOLUTION }]);
    expect(etat.detail).toBe(`conflit au rebase sur main (${ailleurs.slice(0, 7)}) résolu par la session, fichiers : fait.txt ; la session : ${RESOLUTION}`);
    // les deux sessions restent dans l'état, chacune pour ce qu'elle est
    expect(etat.messages).toEqual([{ texte: RAPPORT, tour: 1, marque: true }, { texte: RESOLUTION, tour: 1, sujet: 'résolution du conflit au rebase' }]);
    const lignes = [
      `session, rapport : ${RAPPORT}`,
      'conflit au rebase sur main (fait.txt) : reprise de la session pour le résoudre',
      `session, résolution du conflit au rebase, fin (ne remplace pas le rapport du travail) : ${RESOLUTION}`,
      etat.detail,
    ];
    const positions = lignes.map((x) => journal.indexOf(x));
    expect(positions.every((i) => i >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b)); // dans cet ordre
    expect(journal).toContain(`cadence run ${e.id} : integre (main = ${e.integre})`); // ligne de fin, suivie du détail : le conflit résolu
    expect(journal.slice(journal.indexOf(`cadence run ${e.id} : integre`))).toContain(`\n${etat.detail}`);
  });

  it('quota hebdo pendant la résolution d\'un conflit, puis reprise (L724) : rapport du travail intact, le conflit coupé garde le mot de la reprise', () => {
    const repo = depot(), REPRIS = 'fini : repris après le quota.';
    const exec = parlant(fauxClaude([travailEnConflit(repo), () => HEBDO, () => {}, resout]), [RAPPORT, REPRIS, RESOLUTION]);
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out: () => {}, ...horloge() });
    const etat = JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat;
    expect(etat.etat).toBe('integre');
    expect(etat.rapport).toBe(RAPPORT); // ni la reprise après quota ni la résolution ne remplacent le rapport du travail
    // le rebase coupé par le quota est annulé, puis rejoué : un second conflit, résolu
    expect(etat.conflits?.map((c) => [c.resolu, c.message])).toEqual([[false, REPRIS], [true, RESOLUTION]]);
    expect(etat.messages?.filter((m) => m.texte !== RAPPORT).every((m) => m.sujet === 'résolution du conflit au rebase')).toBe(true);
  });

  it('la cible avance à chaque porte : rendu au lead après 3 rebases, avec la raison', () => {
    const repo = depot(), compte = porte(repo, `git -C ${repo} ${ID.join(' ')} commit -q --allow-empty -m avance`);
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')]), out: () => {} });
    expect(e.etat).toBe('refus-integration');
    expect(e.detail).toMatch(/main a encore avancé après 3 rebases/);
    expect(passages(compte)).toBe(3);
  });
});

describe('cadence run : arbre principal modifié non commité (L723)', () => {
  it('fichier suivi modifié dans l\'arbre principal et par le run : refus clair qui nomme le fichier, rien intégré', () => {
    const repo = depot();
    writeFileSync(join(repo, 'notes.txt'), 'v1'); git(repo, 'add', '.'); git(repo, ...ID, 'commit', '-qm', 'notes');
    const avant = git(repo, 'rev-parse', 'HEAD');
    const exec = fauxClaude([(cwd) => { writeFileSync(join(cwd, 'notes.txt'), 'v2'); commite('fait.txt')(cwd); writeFileSync(join(repo, 'notes.txt'), 'en cours'); }]);
    const e = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e.etat).toBe('refus-integration');
    expect(e.detail).toMatch(/modifications non commitées dans l'arbre principal .* : notes\.txt/);
    expect(e.detail).not.toMatch(/fait\.txt/);
    expect(e.detail).toMatch(new RegExp(`cadence run --reponse ${e.id}`));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('en cours');
  });

  it('fichier non suivi de l\'arbre principal que le run crée : même refus, fichier nommé', () => {
    const repo = depot();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([(cwd) => { commite('fait.txt')(cwd); writeFileSync(join(repo, 'fait.txt'), 'à moi'); }]), out: () => {} });
    expect(e.etat).toBe('refus-integration');
    expect(e.detail).toMatch(/: fait\.txt/);
  });

  it('dossier non suivi de l\'arbre principal : refus si le run y crée un fichier déjà là, intégration sinon', () => {
    for (const [present, attendu] of [['nouveau/a.txt', 'refus-integration'], ['nouveau/b.txt', 'integre']] as const) {
      const repo = depot();
      const exec = fauxClaude([(cwd) => { mkdirSync(join(cwd, 'nouveau')); commite('nouveau/a.txt')(cwd); commite('fait.txt')(cwd); mkdirSync(join(repo, 'nouveau')); writeFileSync(join(repo, present), 'à moi'); }]);
      const e = executerRun({ repo, demande: 'x', exec, out: () => {} });
      expect(e.etat).toBe(attendu);
      if (attendu === 'refus-integration') expect(e.detail).toMatch(/: nouveau\/a\.txt\./);
    }
  });

  it('modification de l\'arbre principal sur un autre fichier : intégration normale', () => {
    const repo = depot();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([(cwd) => { commite('fait.txt')(cwd); writeFileSync(join(repo, 'brouillon.txt'), 'x'); }]), out: () => {} });
    expect(e.etat).toBe('integre');
    expect(existsSync(join(repo, 'brouillon.txt'))).toBe(true);
  });
});
