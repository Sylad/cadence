import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import { chargerBras, cheminReglages, empreinteReglages, environnementNeutre, libererReglages, lancerBras, OUTILS_INTERDITS, type DefBras, type Executeur, type Releve } from '../src/bench/bras.js';
import { dossierTemp } from './temp.js';

function bancTest(reponses?: string): { b: Banc; clone: string } {
  const r = dossierTemp('bras-');
  const dir = join(r, 'bancs', '1-t'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'demande.md'), 'Ajoute un séparateur.');
  if (reponses) writeFileSync(join(dir, 'reponses.md'), reponses);
  const clone = join(r, 'runs', 'x', '1-t', 'A'); mkdirSync(clone, { recursive: true });
  const b: Banc = { id: '1-t', dir, secrets: join(r, 'secrets', '1-t'), projet: 't', source: '/s', base: 'abc1234',
    install: 'true', tests: 'true', visible: false, taille: 'retouche', frais: false, reponses: !!reponses };
  return { b, clone };
}
const json = (session: string, tokens: number, cout: number) => JSON.stringify({ session_id: session, total_cost_usd: cout,
  modelUsage: { 'claude-opus-5-5': { inputTokens: tokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });

describe('lancerBras', () => {
  const brief = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');

  it('une session sans question : mesures, brief rempli, garde-fous passés à claude', () => {
    const { b, clone } = bancTest();
    const appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec: Executeur = (args, o) => { appels.push({ args, env: o.env }); return { stdout: json('s1', 1000, 0.5), code: 0 }; };
    let t = 0; const horloge = () => new Date(Date.UTC(2026, 10, 8, 10, 0, t++ * 90));
    const m = lancerBras(b, { nom: 'A', modele: 'opus', brief }, clone, exec, horloge);
    expect(m).toMatchObject({ bras: 'A', banc: '1-t', duree_s: 90, tokens: 1000, cout_usd: 0.5, questions: 0, questions_texte: [], sessions: ['s1'], echec: null });
    const a = appels[0].args;
    expect(a[a.indexOf('-p') + 1]).toContain('Ajoute un séparateur.');
    expect(a[a.indexOf('-p') + 1]).toContain(clone);
    expect(a[a.indexOf('-p') + 1]).not.toContain('{{');
    expect(a).toContain('--disallowedTools');
    expect(a[a.indexOf('--disallowedTools') + 1].split(',')).toEqual(OUTILS_INTERDITS);
    expect(a[a.indexOf('--model') + 1]).toBe('opus');
    expect(appels[0].env.KUBECONFIG).toBe('/nonexistent');
    expect(appels[0].env.GH_TOKEN).toBe('');
  });

  it('une question : réponse du banc, reprise de la même session, question comptée ; le relevé cumulé de la reprise compté une fois (L703)', () => {
    const { b, clone } = bancTest('Rotation seule.');
    const appels: string[][] = [];
    const exec: Executeur = (args) => {
      appels.push(args);
      if (appels.length === 1) writeFileSync(`${clone}.question.md`, 'Faut-il réorganiser ?');
      return { stdout: json('s1', 500 * appels.length, 0.1 * appels.length), code: 0 }; // claude -p --resume rend le total de la session
    };
    const m = lancerBras(b, { nom: 'A', modele: 'opus', brief }, clone, exec);
    expect(m.questions).toBe(1);
    expect(m.questions_texte).toEqual(['Faut-il réorganiser ?']);
    expect(m.echec).toBeNull();
    expect(m.tokens).toBe(1000); expect(m.cout_usd).toBeCloseTo(0.2);
    expect(m.releve).toMatchObject({ session: 's1', tokens: 1000 });
    expect(appels[1]).toEqual(expect.arrayContaining(['--resume', 's1']));
    expect(appels[1][appels[1].indexOf('-p') + 1]).toContain('Rotation seule.');
    expect(existsSync(`${clone}.question.md`)).toBe(false);
  });

  it('au-delà de 3 questions, on arrête', () => {
    const { b, clone } = bancTest();
    const exec: Executeur = () => { writeFileSync(`${clone}.question.md`, '?'); return { stdout: json('s', 1, 0), code: 0 }; };
    const m = lancerBras(b, { nom: 'A', modele: 'opus', brief }, clone, exec);
    expect(m.questions).toBe(3);
    expect(m.questions_texte).toEqual(['?', '?', '?']);
    expect(m.echec).toBe('question ouverte après 3 réponses');
    expect(existsSync(`${clone}.question.md`)).toBe(false);
  });

  it('session en échec (is_error) : echec renseigné, mesures gardées, boucle arrêtée', () => {
    const { b, clone } = bancTest('x');
    let n = 0;
    const exec: Executeur = () => { n++; writeFileSync(`${clone}.question.md`, '?');
      return { stdout: JSON.stringify({ session_id: 's1', is_error: true, subtype: 'error_max_turns', total_cost_usd: 0.2,
        modelUsage: { m: { inputTokens: 7 } } }), code: 0 }; };
    const m = lancerBras(b, { nom: 'A', modele: 'opus', brief }, clone, exec);
    expect(n).toBe(1);
    expect(m).toMatchObject({ echec: 'session s1 : error_max_turns', tokens: 7, cout_usd: 0.2, questions: 0 });
  });

  it('code non nul avec sortie lisible : echec code N ; session_id absent : echec', () => {
    const { b, clone } = bancTest();
    const d = { nom: 'A', modele: 'opus', brief };
    expect(lancerBras(b, d, clone, () => ({ stdout: json('s1', 1, 0), code: 1 })).echec).toBe('code 1');
    expect(lancerBras(b, d, clone, () => ({ stdout: '{}', code: 0 })).echec).toBe('session_id absent');
  });

  it('sortie illisible : pas d exception, echec avec la cause et la fin de la sortie', () => {
    const { b, clone } = bancTest();
    const d = { nom: 'A', modele: 'opus', brief };
    const m = lancerBras(b, d, clone, () => ({ stdout: 'boum', code: 1 }));
    expect(m).toMatchObject({ echec: 'sortie illisible (code 1) : boum', tokens: 0, cout_usd: 0, sessions: [] });
    expect(lancerBras(b, d, clone, () => ({ stdout: '', code: 1, erreur: 'SIGKILL' })).echec).toBe('sortie illisible (SIGKILL) : ');
  });

  it('réglages du bras : --settings vers un fichier du run en lecture seule, {{HOOKS}} absolu, pièces par l\'environnement, aussi à la reprise (R31)', () => {
    const { b, clone } = bancTest('Oui.');
    const settings = join(import.meta.dirname, '..', 'briefs', 'settings-sequence-v2.json');
    const appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec: Executeur = (args, o) => { appels.push({ args, env: o.env }); if (appels.length === 1) writeFileSync(`${clone}.question.md`, '?'); return { stdout: json('s1', 1, 0), code: 0 }; };
    lancerBras(b, { nom: 'C', modele: 'opus', brief, settings }, clone, exec, undefined, { pieces: ['/ref/a.pdf'], racine: '/banc' });
    expect(appels).toHaveLength(2);
    for (const a of appels) {
      expect(a.args[a.args.indexOf('--settings') + 1]).toBe(cheminReglages(clone));
      expect(a.env).toMatchObject({ CADENCE_CLONE: clone, CADENCE_PIECES: '["/ref/a.pdf"]', CADENCE_BANC_RACINE: '/banc' });
    }
    expect(cheminReglages(clone)).toBe(join(`${clone}.reglages`, 'settings.json'));
    expect(statSync(`${clone}.reglages`).mode & 0o777).toBe(0o500);
    expect(statSync(cheminReglages(clone)).mode & 0o777).toBe(0o400);
    expect(() => writeFileSync(cheminReglages(clone), '{}')).toThrow();
    const j = JSON.parse(readFileSync(cheminReglages(clone), 'utf8'));
    expect(j.hooks.PreToolUse[0].hooks[0].command).toBe(`node "${join(import.meta.dirname, '..', 'hooks', 'lecture-obligatoire.mjs')}" || exit 2`);
    expect(j.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit|Bash');
    const e0 = empreinteReglages(clone);
    lancerBras(b, { nom: 'C', modele: 'opus', brief, settings }, clone, exec); // réécrit à l'identique : même empreinte
    expect(empreinteReglages(clone)).toBe(e0);
    libererReglages(clone); chmodSync(cheminReglages(clone), 0o600); writeFileSync(cheminReglages(clone), '{}');
    expect(empreinteReglages(clone)).not.toBe(e0);
    const e1 = empreinteReglages(clone), home = process.env.HOME; // ~/.claude/settings*.json sont scellés (lus, jamais écrits)
    try {
      process.env.HOME = dossierTemp('home-'); const e2 = empreinteReglages(clone);
      expect(e2).not.toBe(e1);
      mkdirSync(join(process.env.HOME, '.claude')); writeFileSync(join(process.env.HOME, '.claude', 'settings.local.json'), '{"disableAllHooks":true}');
      expect(empreinteReglages(clone)).not.toBe(e2);
    } finally { process.env.HOME = home; }
    const sans: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    lancerBras(b, { nom: 'A', modele: 'opus', brief }, clone, (args, o) => { sans.push({ args, env: o.env }); return { stdout: json('s', 1, 0), code: 0 }; });
    expect(sans[0].args).not.toContain('--settings'); expect(sans[0].env.CADENCE_PIECES).toBeUndefined();
  });

  it('{{TAILLE}} : la taille du gardien (retouche ou fonction), fonction pour un banc court « grosse »', () => {
    const seq = join(import.meta.dirname, '..', 'briefs', 'bras-sequence-v2.md');
    for (const [taille, attendu] of [['retouche', 'retouche'], ['fonction', 'fonction'], ['grosse', 'fonction']] as const) {
      const { b, clone } = bancTest(); const p: string[] = [];
      lancerBras({ ...b, taille }, { nom: 'C', modele: 'opus', brief: seq }, clone, (args) => { p.push(args[args.indexOf('-p') + 1]); return { stdout: json('s', 1, 0), code: 0 }; });
      expect(p[0]).toContain(`Taille fixée par le gardien : ${attendu}.`);
      expect(p[0]).not.toContain('{{');
    }
  });

  it('chargerBras lit settings quand il est donné', () => {
    const r = dossierTemp('brasyaml-');
    writeFileSync(join(r, 'bras.yaml'), 'A:\n  modele: opus\n  brief: /b/a.md\nC:\n  modele: opus\n  brief: /b/c.md\n  settings: /b/s.json\n');
    expect(chargerBras(r)).toEqual({ A: { nom: 'A', modele: 'opus', brief: '/b/a.md' }, C: { nom: 'C', modele: 'opus', brief: '/b/c.md', settings: '/b/s.json' } });
  });

  it('environnement neutre : pas de kube, pas de jeton, pas de prod maritime', () => {
    const e = environnementNeutre({ HOME: '/h', KUBECONFIG: '/h/.kube/config', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', SSH_AUTH_SOCK: '/s' });
    expect(e).toMatchObject({ HOME: '/h', KUBECONFIG: '/nonexistent', GH_TOKEN: '', GITHUB_TOKEN: '', GH_CONFIG_DIR: '/nonexistent', SSH_AUTH_SOCK: '', AETHERWX_URL: 'http://127.0.0.1:9' });
  });
});

describe('lancerBras, suite de session (L690)', () => {
  const brief = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  const banc = (): { b: Banc; clone: string } => {
    const r = dossierTemp('suite-');
    const dir = join(r, 'b'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'demande.md'), 'Demande 2.');
    const clone = join(r, 'clone'); mkdirSync(clone);
    return { b: { id: 'm-2', dir, secrets: '', projet: 't', source: '', base: 'abc', install: 'true', tests: 'true', visible: false, taille: 'fonction', frais: false, reponses: false }, clone };
  };
  const sortie = (s: string) => JSON.stringify({ session_id: s, total_cost_usd: 0.1, subtype: 'success', modelUsage: { m: { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
  it('gardée : la demande suivante reprend la session de la précédente', () => {
    const { b, clone } = banc(); const appels: string[][] = [];
    const m = lancerBras(b, { nom: 'g', modele: 'opus', brief, suite: 'gardee' }, clone, (a) => { appels.push(a); return { stdout: sortie('s9'), code: 0 }; }, undefined, undefined, { session: 's1', cout: 0, tokens: 0 });
    expect(appels).toHaveLength(1);
    expect(appels[0].slice(appels[0].indexOf('--resume'), appels[0].indexOf('--resume') + 2)).toEqual(['--resume', 's1']);
    expect(m.sessions).toEqual(['s9']);
  });
  it('compactée : /compact dirigé sur la session précédente, puis la demande dans la session compactée ; tokens et coût comptés', () => {
    const { b, clone } = banc(); const appels: string[][] = [];
    const m = lancerBras(b, { nom: 'c', modele: 'opus', brief, suite: 'compactee' }, clone, (a) => { appels.push(a); return { stdout: sortie(appels.length === 1 ? 's1c' : 's2'), code: 0 }; }, undefined, undefined, { session: 's1', cout: 0, tokens: 0 });
    expect(appels).toHaveLength(2);
    expect(appels[0][1]).toMatch(/^\/compact Garde : les décisions/);
    expect(appels[0]).toEqual(expect.arrayContaining(['--resume', 's1']));
    expect(appels[1]).toEqual(expect.arrayContaining(['--resume', 's1c']));
    expect(m).toMatchObject({ tokens: 20 }); expect(m.cout_usd).toBeCloseTo(0.2);
  });
  it('sans suite, ou sans session précédente : session neuve', () => {
    const { b, clone } = banc(); const appels: string[][] = [];
    lancerBras(b, { nom: 'n', modele: 'opus', brief }, clone, (a) => { appels.push(a); return { stdout: sortie('x'), code: 0 }; }, undefined, undefined, { session: 's1', cout: 0, tokens: 0 });
    lancerBras(b, { nom: 'g', modele: 'opus', brief, suite: 'gardee' }, clone, (a) => { appels.push(a); return { stdout: sortie('y'), code: 0 }; });
    expect(appels.every((a) => !a.includes('--resume'))).toBe(true);
  });
});

/** L703 : relevés réels du banc 2026-11-10-1551-b4bcc9ea9150 (cost-state des journaux = sorties de claude -p), rejoués appel par appel. */
describe('lancerBras, coût d\'un bras qui reprend sa session (L703)', () => {
  const brief = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  type Sortie = { session_id: string; total_cost_usd: number; modelUsage: Record<string, Record<string, number>> };
  const F = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'releves-banc-2026-11-10.json'), 'utf8')) as Record<string, Record<'neuve' | 'gardee', Sortie[][]>>;
  /** Trois étapes comme le banc séquence : le relevé de fin de l'étape k est repris à l'étape k+1 ; le bras seuil a compacté avant l'étape 2 seulement. */
  const jouer = (etapes: Sortie[][], suite: boolean) => etapes.reduce<{ cout: number; tokens: number; releve?: Releve }>((acc, sorties, i) => {
    const { b, clone } = bancTest(); let n = 0;
    const d: DefBras = { nom: 'x', modele: 'opus', brief, ...(suite ? { suite: sorties.length === 2 ? 'compactee' as const : 'gardee' as const } : {}) };
    const m = lancerBras(b, d, clone, () => ({ stdout: JSON.stringify({ ...sorties[n++], subtype: 'success' }), code: 0 }), undefined, undefined, acc.releve);
    expect(n, `étape ${i + 1} : appels`).toBe(sorties.length);
    return { cout: acc.cout + m.cout_usd, tokens: acc.tokens + m.tokens, releve: m.releve };
  }, { cout: 0, tokens: 0 });

  it.each([['r1', 10.01, 8.42], ['r2', 9.08, 9.14]] as const)('%s : session gardée %s $, session neuve %s $', (r, gardee, neuve) => {
    const g = jouer(F[r].gardee, true), n = jouer(F[r].neuve, false);
    expect(g.cout).toBeCloseTo(gardee, 2); expect(n.cout).toBeCloseTo(neuve, 2);
    const fin = Object.values(F[r].gardee[2][0].modelUsage)[0]; // tokens : le total de la session à sa fin, pas la somme des totaux
    expect(g.tokens).toBe(fin.inputTokens + fin.outputTokens + fin.cacheReadInputTokens + fin.cacheCreationInputTokens);
  });
  it('r1 : 24,9 M tokens pour la session gardée, et non 79,2 M', () => {
    expect(jouer(F.r1.gardee, true).tokens / 1e6).toBeCloseTo(24.9, 1);
  });
});
