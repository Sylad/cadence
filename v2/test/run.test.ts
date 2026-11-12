import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun, repondreRun, type Etat } from '../src/run/run.js';
import { commite, depot, fauxClaude, git, io } from './run-outils.js';

describe('cadence run', () => {
  it('une demande : worktree avec dépendances, session avec brief mesuré et hook, porte verte, intégration en avance rapide, worktree retiré', () => {
    const repo = depot(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let vu = { deps: false };
    const exec = fauxClaude([(cwd, a, e) => { vu.deps = existsSync(join(cwd, 'node_modules', 'dep', 'index.js')); commite('fait.txt', 'pour plus tard : un export')(cwd); void a; void e; }], appels);
    const { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', pieces: ['cadence.yaml'], registre: 'humaine', exec, out }); // L701 : une demande de l'humain
    expect(e.etat).toBe('integre');
    expect(vu.deps).toBe(true);
    expect(git(repo, 'log', '--oneline', '-1')).toMatch(/ajoute fait.txt/);
    expect(existsSync(e.worktree)).toBe(false);
    expect(existsSync(`${e.worktree}.reglages`)).toBe(false);
    const [args, env] = [appels[0].args, appels[0].env];
    expect(args[args.indexOf('-p') + 1]).toMatch(/^Crée fait.txt[\s\S]*Registre des demandes/);
    expect(args).toContain('--settings');
    expect(env.CADENCE_CLONE).toBe(e.worktree);
    expect(JSON.parse(env.CADENCE_PIECES ?? '[]')).toEqual([join(e.worktree, 'cadence.yaml')]);
    expect(l.join('\n')).toMatch(/D-1 ouverte : pour plus tard : un export/);
  });

  it('porte rouge : la même session est reprise une fois avec la sortie de la porte, puis intégration', () => {
    const repo = depot(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec = fauxClaude([commite('autre.txt'), commite('fait.txt')], appels);
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out: () => {} });
    expect(e.etat).toBe('integre');
    expect(appels[1].args).toEqual(expect.arrayContaining(['--resume', 's1']));
    expect(appels[1].args[appels[1].args.indexOf('-p') + 1]).toMatch(/porte complète est rouge/);
  });

  it('porte encore rouge après la reprise : rien n intégré, worktree gardé', () => {
    const repo = depot(), base = git(repo, 'rev-parse', 'HEAD');
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('a.txt'), commite('b.txt')]), out: () => {} });
    expect(e.etat).toBe('porte-rouge');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(base);
    expect(existsSync(e.worktree)).toBe(true);
  });

  it('question : état « attente », puis --reponse reprend la session et termine', () => {
    const repo = depot();
    const exec = fauxClaude([(cwd) => writeFileSync(`${cwd}.question.md`, 'Rouge ou bleu ?'), commite('fait.txt')]);
    const { l, out } = io();
    const e1 = executerRun({ repo, demande: 'x', exec, out });
    expect(e1.etat).toBe('attente');
    expect(l.join('\n')).toMatch(/Rouge ou bleu \?/);
    const e2 = repondreRun(e1.id, repo, 'bleu', { exec, out });
    expect(e2.etat).toBe('integre');
  });

  it('la branche principale a avancé pendant la session : rebase puis intégration', () => {
    const repo = depot();
    const exec = fauxClaude([(cwd) => { commite('fait.txt')(cwd); commite('ailleurs.txt')(repo); }]);
    const e: Etat = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e.etat).toBe('integre');
    expect(git(repo, 'log', '--format=%s')).toMatch(/ajoute fait.txt\najoute ailleurs.txt/);
  });

  it('sans pièce ni référence : mode léger, brief de Claude seul ; réglages : les coupes du socle (L705), sans hook de lecture', () => {
    const repo = depot(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const { l, out } = io();
    let r: Record<string, unknown> = {}; // lu pendant la session : le dossier des réglages est retiré à l'intégration
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([(c, a) => { r = JSON.parse(readFileSync(a[a.indexOf('--settings') + 1], 'utf8')); commite('fait.txt')(c); }], appels), out });
    expect(e).toMatchObject({ etat: 'integre', mode: 'leger' });
    expect(r).toMatchObject({ disableClaudeAiConnectors: true, autoMemoryEnabled: false });
    expect(r.hooks).toBeUndefined();
    expect(l[0]).toMatch(/mode leger \(aucune référence dans la demande\)/);
  });

  it('dépôt réel : pas de ligne « Taille » (commitlint), lot cité, sans prodAccess ni kubectl ni KUBECONFIG', () => {
    const repo = depot(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    executerRun({ repo, demande: 'Crée fait.txt', pieces: ['cadence.yaml'], lot: 'L51', exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    const prompt = appels[0].args[appels[0].args.indexOf('-p') + 1];
    expect(prompt).not.toMatch(/Taille fixée/);
    expect(prompt).toMatch(/Lot du plan : L51\. Cite-le dans chaque message de commit/);
    expect(appels[0].args[appels[0].args.indexOf('--disallowedTools') + 1]).toMatch(/Bash\(kubectl:\*\)/);
    expect(appels[0].env.KUBECONFIG).toBe('/dev/null');
  });

  it('orchestrate.prodAccess: true : kubectl et helm permis, KUBECONFIG gardé (banc du projet)', () => {
    const repo = depot(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  test: test -f fait.txt\n  prodAccess: true\n');
    git(repo, 'add', '.'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'prodAccess');
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    expect(e.acces_cluster).toBe(true);
    expect(appels[0].args[appels[0].args.indexOf('--disallowedTools') + 1]).not.toMatch(/kubectl|helm/);
    expect(appels[0].env.KUBECONFIG).toBe(process.env.KUBECONFIG);
  });

  it('aucun commit : échec, rien intégré', () => {
    const repo = depot();
    const e = executerRun({ repo, demande: 'x', exec: fauxClaude([]), out: () => {} });
    expect(e.etat).toBe('sans-commit');
    expect(JSON.parse(readFileSync(e.fichier, 'utf8')).etat).toBe('sans-commit');
  });
});

describe('cadence run : choix du modèle (L699)', () => {
  type Appels = { args: string[]; env: NodeJS.ProcessEnv }[];
  const modeleDe = (a: Appels, i = 0) => a[i].args[a[i].args.indexOf('--model') + 1];

  for (const [mode, pieces] of [['leger', []], ['complet', ['cadence.yaml']]] as const) {
    it(`bras ${mode} : le modèle demandé arrive dans la commande claude, la ligne de lancement et l'état`, () => {
      const repo = depot(), appels: Appels = [], { l, out } = io();
      const e = executerRun({ repo, demande: 'Crée fait.txt', pieces: [...pieces], modele: 'fable', exec: fauxClaude([commite('fait.txt')], appels), out });
      expect(e).toMatchObject({ etat: 'integre', mode, modele: 'fable' });
      expect(modeleDe(appels)).toBe('fable');
      expect(appels[0].args.filter((x) => x === '--model')).toHaveLength(1);
      expect(l[0]).toMatch(new RegExp(`session Fable en mode ${mode} `));
      expect(l[0]).not.toMatch(/Opus/);
    });

    it(`bras ${mode} : sans choix, opus, et la ligne de lancement le dit`, () => {
      const repo = depot(), appels: Appels = [], { l, out } = io();
      const e = executerRun({ repo, demande: 'Crée fait.txt', pieces: [...pieces], exec: fauxClaude([commite('fait.txt')], appels), out });
      expect(e).toMatchObject({ mode, modele: 'opus' });
      expect(modeleDe(appels)).toBe('opus');
      expect(l[0]).toMatch(new RegExp(`session Opus en mode ${mode} `));
    });
  }

  it('porte rouge puis --reponse : chaque reprise garde le modèle du lancement, lu dans l\'état', () => {
    const repo = depot(), appels: Appels = [];
    const exec = fauxClaude([commite('a.txt'), commite('b.txt'), commite('fait.txt')], appels);
    const e1 = executerRun({ repo, demande: 'x', modele: 'fable', exec, out: () => {} });
    expect(e1.etat).toBe('porte-rouge');
    expect(JSON.parse(readFileSync(e1.fichier, 'utf8')).modele).toBe('fable');
    expect(repondreRun(e1.id, repo, 'crée fait.txt', { exec, out: () => {} }).etat).toBe('integre');
    expect(appels.map((_, i) => modeleDe(appels, i))).toEqual(['fable', 'fable', 'fable']);
    expect(appels[2].args).toEqual(expect.arrayContaining(['--resume', 's2']));
  });

  it('état écrit avant L699 (sans modèle) : la reprise part en opus', () => {
    const repo = depot(), appels: Appels = [];
    const exec = fauxClaude([(cwd) => writeFileSync(`${cwd}.question.md`, 'Rouge ou bleu ?'), commite('fait.txt')], appels);
    const e1 = executerRun({ repo, demande: 'x', exec, out: () => {} });
    const { modele: _retire, ...ancien } = JSON.parse(readFileSync(e1.fichier, 'utf8')) as Etat;
    writeFileSync(e1.fichier, JSON.stringify(ancien));
    expect(repondreRun(e1.id, repo, 'bleu', { exec, out: () => {} }).etat).toBe('integre');
    expect(modeleDe(appels, 1)).toBe('opus');
  });

  for (const refuse of ['gpt', 'sonnet', 'haiku', 'Opus']) it(`modèle ${refuse} : refusé avant toute création (ni worktree, ni branche, ni état), aucune session`, () => {
    const repo = depot(), appels: Appels = [];
    expect(() => executerRun({ repo, demande: 'x', modele: refuse, exec: fauxClaude([], appels), out: () => {} })).toThrow(new RegExp(`modèle inconnu : « ${refuse} » ; attendu : opus, fable$`));
    expect(appels).toEqual([]);
    expect(git(repo, 'branch', '--format=%(refname:short)')).toBe('main');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(existsSync(join(dirname(repo), '.cadence-run'))).toBe(false);
  });
});
