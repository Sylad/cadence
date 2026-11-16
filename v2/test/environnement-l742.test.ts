import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { bench, passage } from '../src/bench/cli.js';
import { ajouterSession, claudeVide, ecartsEnvironnement, enteteEnvironnement, environnement, reglagesClaude, versionClaude, type Environnement } from '../src/bench/environnement.js';
import { conclureSequence } from '../src/sequence/verdict.js';
import type { MesureEtape, ResultatSequence } from '../src/sequence/passage.js';
import { ioTest } from './cli.test.js';
import { dossierTemp } from './temp.js';

// L742 (D-23 B, demande de Sylvain du 16-11) : chaque rapport de banc note la version de Claude Code, l'identifiant exact du modèle de chaque bras
// (l'alias résolu, lu dans le flux de ses sessions) et les réglages qui changent le coût ou le comportement ; deux rapports dont ces champs
// diffèrent le disent en tête quand on les compare. Vécu : Claude Code 2.1.293 → 2.1.325 sur Big-Blue, l'alias fable devenu Fable 5.2 le 09-11.

const FLUX_2_1_325 = readFileSync(join(import.meta.dirname, 'fixtures', 'flux-init-2.1.325.jsonl'), 'utf8'); // capture réelle de claude -p, 16-11

/** Un flux stream-json minimal d'une session : init (version, modèle), puis le result et son modelUsage. */
const flux = (version: string, modele: string, autres: string[] = []) => [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: modele, claude_code_version: version }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 0,
    modelUsage: Object.fromEntries([modele, ...autres].map((m) => [m, { inputTokens: 1, contextWindow: 1_000_000 }])) }),
].join('\n');

describe('ce que la session dit d\'elle-même', () => {
  it('le vrai flux de claude -p 2.1.325 donne la version, le modèle exact et son contexte max', () => {
    expect(ajouterSession(claudeVide(), FLUX_2_1_325)).toEqual({ versions: ['2.1.325'], modeles: ['claude-haiku-5-5'], autres_modeles: [], contexte_max: { 'claude-haiku-5-5': 1_000_000 }, reglages: {} });
  });
  it('un modèle facturé autre que celui de la session (sous-agent) est noté à part ; un flux illisible n\'ajoute rien', () => {
    const c = ajouterSession(ajouterSession(claudeVide(), flux('2.1.325', 'claude-opus-5-5', ['claude-fable-5-2'])), 'pas du json\n{"type":"result"}');
    expect(c).toMatchObject({ modeles: ['claude-opus-5-5'], autres_modeles: ['claude-fable-5-2'] });
  });
});

describe('les réglages suivis', () => {
  it('effort, variables suivies et réglages des fichiers ; jamais un identifiant, un courriel ou un jeton', () => {
    const home = dossierTemp('env-l742-');
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'high', theme: 'dark', env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', KUBECONFIG: '/k' } }));
    const bras = join(home, 'reglages-bras.json');
    writeFileSync(bras, JSON.stringify({ fastMode: false, hooks: {} }));
    const r = reglagesClaude({ HOME: home, CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES: '1', CLAUDE_CODE_USER_EMAIL: 'x@y', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_CODE_SESSION_ID: 'id', ANTHROPIC_API_KEY: 'k', PATH: '/bin', CLAUDE_CODE_DISABLE_CRON: '' }, bras);
    expect(r).toEqual({
      'env CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES': '1',
      'env CLAUDE_CODE_DISABLE_CRON': '(vide)',
      'réglages utilisateur effortLevel': 'high',
      'réglages utilisateur env CLAUDE_CODE_MAX_OUTPUT_TOKENS': '64000',
      'réglages du bras reglages-bras.json fastMode': 'false',
    });
  });
  it('sans effort ni variable : l\'absence est écrite', () => {
    expect(reglagesClaude({ HOME: dossierTemp('env-l742-') })).toEqual({ effort: 'non réglé (défaut de Claude Code)', 'env CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES': 'non posée' });
  });
  it('CLAUDE_CONFIG_DIR : les réglages utilisateur se lisent dans ce dossier, pas dans ~/.claude, et la variable est notée', () => {
    const home = dossierTemp('env-l742-'), conf = join(home, 'conf');
    mkdirSync(join(home, '.claude')); mkdirSync(conf);
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'low' }));
    writeFileSync(join(conf, 'settings.json'), JSON.stringify({ effortLevel: 'xhigh', model: 'opus' }));
    expect(reglagesClaude({ HOME: home, CLAUDE_CONFIG_DIR: conf })).toEqual({
      'env CLAUDE_CONFIG_DIR': conf, 'réglages utilisateur effortLevel': 'xhigh', 'réglages utilisateur model': 'opus', 'env CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES': 'non posée' });
  });
  it('un fichier de réglages illisible (utilisateur ou bras) est écrit « illisible (<fichier>) », sans arrêter la lecture des autres', () => {
    const home = dossierTemp('env-l742-'), bras = join(home, 'bras.json'), user = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'));
    writeFileSync(user, '{ pas du json'); writeFileSync(bras, JSON.stringify({ effortLevel: 'medium' }));
    expect(reglagesClaude({ HOME: home }, bras)).toMatchObject({ 'réglages utilisateur': `illisible (${user})`, 'réglages du bras bras.json effortLevel': 'medium' });
    writeFileSync(user, '{}'); writeFileSync(bras, 'cassé');
    expect(reglagesClaude({ HOME: home }, bras)).toMatchObject({ 'réglages du bras bras.json': `illisible (${bras})`, effort: 'non réglé (défaut de Claude Code)' });
  });
});

describe('la version de Claude Code au lancement', () => {
  const faux = (sortie: string) => { const f = join(dossierTemp('claude-l742-'), 'claude'); writeFileSync(f, `#!/bin/sh\nprintf '${sortie}'\n`); chmodSync(f, 0o755); return f; };
  it('« 2.1.325 (Claude Code) » donne 2.1.325', () => expect(versionClaude(faux('2.1.325 (Claude Code)\\n'))).toBe('2.1.325'));
  it('claude absent ou muet : « inconnue »', () => {
    expect(versionClaude(join(dossierTemp('claude-l742-'), 'absent'))).toBe('inconnue');
    expect(versionClaude(faux(''))).toBe('inconnue');
  });
});

describe('deux environnements comparés', () => {
  const env = (version: string, fable: string, effort = 'high'): Environnement =>
    environnement(version, { A: 'opus', F: 'fable' }, [
      { bras: 'A', claude: { ...ajouterSession(claudeVide({ effort }), flux(version, 'claude-opus-5-5')) } },
      { bras: 'F', claude: { ...ajouterSession(claudeVide({ effort }), flux(version, fable)) } },
    ]);
  it('identiques : aucune différence', () => expect(ecartsEnvironnement(env('2.1.325', 'claude-fable-5-2'), env('2.1.325', 'claude-fable-5-2'))).toEqual([]));
  it('le contexte max d\'un modèle présent dans les deux est comparé', () => {
    const a = env('2.1.325', 'claude-fable-5-2'), b = env('2.1.325', 'claude-fable-5-2');
    b.bras.F.contexte_max['claude-fable-5-2'] = 200_000;
    expect(ecartsEnvironnement(a, b)).toEqual(['contexte max de claude-fable-5-2 (F) : 1 000 000 → 200 000']);
  });
  it('un bras qui lance un sous-agent dans un passage et pas dans l\'autre ne change pas l\'environnement (revue L742, constat 3)', () => {
    const avec = environnement('2.1.325', { A: 'opus', F: 'fable' }, [
      { bras: 'A', claude: ajouterSession(claudeVide({ effort: 'high' }), flux('2.1.325', 'claude-opus-5-5', ['claude-haiku-5-5'])) },
      { bras: 'F', claude: ajouterSession(claudeVide({ effort: 'high' }), flux('2.1.325', 'claude-fable-5-2')) },
    ]);
    expect(avec.bras.A.autres_modeles).toEqual(['claude-haiku-5-5']);
    expect(ecartsEnvironnement(env('2.1.325', 'claude-fable-5-2'), avec)).toEqual([]);
    expect(ecartsEnvironnement(avec, env('2.1.325', 'claude-fable-5-2'))).toEqual([]);
  });
  it('la version, le modèle derrière un alias et un réglage changés sont nommés', () => {
    expect(ecartsEnvironnement(env('2.1.293', 'claude-fable-5-1'), env('2.1.325', 'claude-fable-5-2', 'medium'))).toEqual([
      'Claude Code : 2.1.293 → 2.1.325', 'alias fable : claude-fable-5-1 → claude-fable-5-2', 'effort (A) : high → medium', 'effort (F) : high → medium']);
  });
});

describe('l\'en-tête d\'un rapport', () => {
  const bras = (version: string, reglages: Record<string, string>) => ajouterSession(claudeVide(reglages), flux(version, 'claude-opus-5-5'));
  it('une session qui annonce une autre version que claude --version (mise à jour pendant le passage) : « ; sessions : »', () => {
    const e = environnement('2.1.325', { A: 'opus', F: 'opus' }, [{ bras: 'A', claude: bras('2.1.325', {}) }, { bras: 'F', claude: bras('2.1.326', {}) }]);
    expect(enteteEnvironnement(e, null)[1]).toBe('Claude Code : 2.1.325 (claude --version au lancement) ; sessions : 2.1.325, 2.1.326');
    const memes = environnement('2.1.325', { A: 'opus' }, [{ bras: 'A', claude: bras('2.1.325', {}) }]);
    expect(enteteEnvironnement(memes, null)[1]).toBe('Claude Code : 2.1.325 (claude --version au lancement)');
  });
  it('deux bras aux réglages différents : une ligne « Réglages de » par bras ; aucun réglage : « aucun »', () => {
    const e = environnement('2.1.325', { A: 'opus', F: 'opus' }, [{ bras: 'A', claude: bras('2.1.325', { effort: 'high' }) }, { bras: 'F', claude: bras('2.1.325', {}) }]);
    expect(enteteEnvironnement(e, null).slice(-2)).toEqual(['Réglages de A : effort = high', 'Réglages de F : aucun']);
  });
});

describe('le rapport d\'un passage porte l\'environnement et le compare au précédent', () => {
  const BRIEF = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  function racine(): string {
    const r = dossierTemp('bench-l742-');
    mkdirSync(join(r, 'bancs', '1-a'), { recursive: true }); mkdirSync(join(r, 'secrets', '1-a'), { recursive: true });
    writeFileSync(join(r, 'bancs', '1-a', 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: fonction\n');
    writeFileSync(join(r, 'bancs', '1-a', 'demande.md'), 'd');
    writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${BRIEF}\nF:\n  modele: fable\n  brief: ${BRIEF}\n`);
    return r;
  }
  const prep = (_b: unknown, cible: string) => {
    mkdirSync(cible, { recursive: true });
    execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: cible });
    return { testsBase: 0 };
  };
  /** Faux claude : la session de l'alias fable dit `fable`, celle de opus claude-opus-5-5, toutes en `version`. */
  const exec = (version: string, fable: string): Executeur => (args, o) => {
    writeFileSync(join(o.cwd, 'f.ts'), 'x');
    execFileSync('bash', ['-c', 'git add -A && git -c user.email=t@t -c user.name=t commit -q -m bras'], { cwd: o.cwd });
    return { stdout: flux(version, args[args.indexOf('--model') + 1] === 'fable' ? fable : 'claude-opus-5-5'), code: 0 };
  };
  const jouer = (r: string, quand: string, version: string, fable: string, out: string[] = []) => passage({ racine: r, ref: 'A', cand: 'F', hebdo: false, juge: 'opus',
    niveau: 'mecanique', exec: exec(version, fable), prep: prep as never, maintenant: new Date(quand), empreinte: 'e1', home: r, out: (l) => out.push(l), version: () => version });
  const md = (r: string, run: string) => readFileSync(join(r, 'rapports', `${run}.md`), 'utf8').split('\n');

  it('premier passage : version, modèle exact de chaque bras, contexte max et réglages, dans le .md et le .json', async () => {
    const r = racine();
    await jouer(r, '2026-11-14T09:00:00Z', '2.1.293', 'claude-fable-5-1');
    const l = md(r, '2026-11-14-1000-e1');
    expect(l.slice(2, 6)).toEqual([
      'Environnement : premier rapport de cette racine, rien à comparer',
      'Claude Code : 2.1.293 (claude --version au lancement)',
      'Bras A : alias opus → claude-opus-5-5 ; contexte max : claude-opus-5-5 1 000 000',
      'Bras F : alias fable → claude-fable-5-1 ; contexte max : claude-fable-5-1 1 000 000',
    ]);
    expect(l[6]).toMatch(/^Réglages \(les deux bras\) : .*env CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES = /);
    const j = JSON.parse(readFileSync(join(r, 'rapports', '2026-11-14-1000-e1.json'), 'utf8'));
    expect(j.environnement).toMatchObject({ claude_code: '2.1.293', bras: { A: { alias: 'opus', modeles: ['claude-opus-5-5'] }, F: { alias: 'fable', modeles: ['claude-fable-5-1'] } } });
  });

  it('second passage après la mise à jour : la différence est la première ligne après le titre, et sur la sortie', async () => {
    const r = racine(), out: string[] = [];
    await jouer(r, '2026-11-14T09:00:00Z', '2.1.293', 'claude-fable-5-1');
    await jouer(r, '2026-11-16T09:00:00Z', '2.1.325', 'claude-fable-5-2', out);
    const ligne = '⚠ Environnement différent de 2026-11-14-1000-e1 : Claude Code : 2.1.293 → 2.1.325 ; alias fable : claude-fable-5-1 → claude-fable-5-2';
    expect(md(r, '2026-11-16-1000-e1')[2]).toBe(ligne);
    expect(out).toContain(ligne);
    await jouer(r, '2026-11-16T10:00:00Z', '2.1.325', 'claude-fable-5-2');
    expect(md(r, '2026-11-16-1100-e1')[2]).toBe('Environnement identique à 2026-11-16-1000-e1');
  });

  it('bench comparer : deux rapports quelconques, environnement d\'abord ; un rapport d\'avant L742 n\'est pas comparable', async () => {
    const r = racine();
    await jouer(r, '2026-11-14T09:00:00Z', '2.1.293', 'claude-fable-5-1');
    await jouer(r, '2026-11-16T09:00:00Z', '2.1.325', 'claude-fable-5-2');
    const io = ioTest({ BENCH_ROOT: r, HOME: r });
    expect(await bench(['comparer', '2026-11-14-1000-e1', '2026-11-16-1000-e1.md'], io)).toBe(1);
    expect(io.sortie[0]).toBe('2026-11-16-1000-e1 contre 2026-11-14-1000-e1 — ⚠ Environnement différent de 2026-11-14-1000-e1 : Claude Code : 2.1.293 → 2.1.325 ; alias fable : claude-fable-5-1 → claude-fable-5-2');
    expect(io.sortie[1]).toMatch(/^2026-11-14-1000-e1 : Banc 2026-11-14 — F contre A — /);
    const memes = ioTest({ BENCH_ROOT: r, HOME: r });
    expect(await bench(['comparer', '2026-11-16-1000-e1', '2026-11-16-1000-e1'], memes)).toBe(0);
    writeFileSync(join(r, 'rapports', '2026-11-10-0900-vieux.json'), JSON.stringify({ verdict: { vert: true, criteres: [] }, resultats: [] }));
    const vieux = ioTest({ BENCH_ROOT: r, HOME: r });
    expect(await bench(['comparer', '2026-11-10-0900-vieux', '2026-11-16-1000-e1'], vieux)).toBe(1);
    expect(vieux.sortie[0]).toMatch(/Environnement non comparable à 2026-11-10-0900-vieux : ce rapport ne le note pas \(rapport d'avant L742\)/);
    const usage = ioTest({ BENCH_ROOT: r, HOME: r });
    expect(await bench(['comparer', 'absent', '2026-11-16-1000-e1'], usage)).toBe(2);
    expect(await bench(['comparer'], usage)).toBe(2);
  });
});

describe('le rapport d\'une séquence porte aussi l\'environnement', () => {
  it('modèles lus dans les mesures de chaque étape, comparé au rapport précédent', () => {
    const r = dossierTemp('seq-l742-');
    mkdirSync(join(r, 'rapports'));
    writeFileSync(join(r, 'rapports', '2026-11-14-1000-e1.json'), JSON.stringify({ environnement: environnement('2.1.293', { A: 'opus' }, [{ bras: 'A', claude: ajouterSession(claudeVide(), flux('2.1.293', 'claude-opus-5-5')) }]) }));
    const etape = (b: string): MesureEtape => ({ k: 1, portee_suite: 'tout', fuites: [], fuites_a_verifier: [], suite_en_erreur: null, mesure_en_erreur: null,
      mesure: { bras: 'c1', banc: 's', debut: '', fin: '', duree_s: 1, tokens: 1, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: null,
        claude: ajouterSession(claudeVide(), flux('2.1.325', b === 'A' ? 'claude-opus-5-5' : 'claude-fable-5-2')) } });
    const s: ResultatSequence = { run: '2026-11-16-1000-e1', sequence: 'q', clones: {}, base: {}, etapes: { A: [etape('A')], F: [etape('F')] }, jugement: null };
    conclureSequence(r, s, 'A', 'F', { maintenant: new Date('2026-11-16T09:00:00Z'), empreinte: 'e1', modele_candidat: 'fable', alias: { A: 'opus', F: 'fable' }, version: '2.1.325' });
    const l = readFileSync(join(r, 'rapports', '2026-11-16-1000-e1-q-r1.md'), 'utf8').split('\n');
    expect(l[2]).toBe('⚠ Environnement différent de 2026-11-14-1000-e1 : Claude Code : 2.1.293 → 2.1.325');
    expect(l).toContain('Bras F : alias fable → claude-fable-5-2 ; contexte max : claude-fable-5-2 1 000 000');
  });
});
