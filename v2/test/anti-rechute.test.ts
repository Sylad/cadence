// Tests anti-rechute (Task 14) : une règle par cause de l'échec du 07-11 (spec §0), sans IA, en quelques secondes.
// Chaque règle est une fonction PURE sur le contenu des fichiers (Record chemin -> texte) qui renvoie ses violations.
// 1. les vrais fichiers donnent [] ; 2. une table de mutations applique chaque régression connue à une copie EN MÉMOIRE
// des vrais contenus et exige au moins une violation (rien n'est écrit sur disque). Le budget de lignes (C4) vit dans budget.test.ts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lancerBras, type Executeur } from '../src/bench/bras.js';
import { BARRE_SPEC, ligneHistorique, rapport, statut, verdict, type ResultatBanc } from '../src/bench/verdict.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Banc } from '../src/bench/banc.js';

const v2 = join(import.meta.dirname, '..');
const depot = join(v2, '..');
type Fichiers = Record<string, string>;

function chemins(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? chemins(p, ext) : ext.test(e) ? [p] : [];
  });
}
function chargerReel(): Fichiers {
  const f: Fichiers = {};
  for (const p of chemins(join(v2, 'src'), /\.ts$/)) f[`src/${p.slice(join(v2, 'src').length + 1)}`] = readFileSync(p, 'utf8');
  for (const p of chemins(join(v2, 'briefs'), /\.md$/)) f[`briefs/${p.slice(join(v2, 'briefs').length + 1)}`] = readFileSync(p, 'utf8');
  f['budget.json'] = readFileSync(join(v2, 'budget.json'), 'utf8');
  f['options.json'] = readFileSync(join(v2, 'options.json'), 'utf8');
  f['docs/banc.md'] = readFileSync(join(depot, 'docs', 'v2', 'banc.md'), 'utf8');
  return f;
}
const reel = chargerReel();
const sources = (f: Fichiers) => Object.keys(f).filter((k) => k.startsWith('src/'));
const briefsDe = (f: Fichiers) => Object.keys(f).filter((k) => k.startsWith('briefs/'));
const BRIEF_CAND = 'briefs/bras-equipe-legere.md';

/** Sans commentaires (les `//` précédés de `:` sont ceux des URL). */
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w])\/\/.*$/gm, '$1');
const sansChaines = (s: string) => s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");

// ---------------------------------------------------------------------------------------------------------------------
// C1, conformité à une fiche figée
// Légitimes : « Conformité » est un titre de mesure.md dans ajouter.ts ; « gabarit » est un paramètre de juges.ts (fichier modèle de brief).
const AUTORISES_C1: Record<string, string[]> = { 'src/bench/ajouter.ts': ['conformit'], 'src/bench/juges.ts': ['gabarit'] };
const MOTS_C1: [string, RegExp][] = [['scell', /scell/i], ['acceptation', /acceptation/i], ['fiche', /fiche/i], ['maquette', /maquette/i],
  ['spec:', /(?<![\w])spec:/i], ['contrat', /contrat/i], ['gabarit', /gabarit/i], ['seal', /seal/i], ['golden', /golden/i],
  ['snapshot', /snapshot/i], ['conformit', /conformit/i]]; // `spec:` = clé de fiche, pas BARRE_SPEC:
const PHRASE_RELECTEUR = /Donne-lui seulement le texte de la demande ci-dessus et la sortie de `git -C \{\{CLONE\}\} diff/;

function reglesC1(f: Fichiers): string[] {
  const v: string[] = [];
  for (const k of [...sources(f), ...briefsDe(f)])
    for (const [mot, re] of MOTS_C1) if (re.test(f[k]) && !(AUTORISES_C1[k] ?? []).includes(mot)) v.push(`C1 : « ${mot} » dans ${k}`);
  const b = f[BRIEF_CAND] ?? '';
  if (!b.includes('{{DEMANDE}}')) v.push('C1 : le brief candidat ne contient pas {{DEMANDE}}');
  if (!b.includes('le texte de la demande') || !b.includes('git -C {{CLONE}} diff')) v.push('C1 : le relecteur ne reçoit pas demande + diff');
  const para = b.split('\n').find((l) => l.startsWith('- Relecture')) ?? '';
  if (!PHRASE_RELECTEUR.test(para)) v.push('C1 : phrase exacte du relecteur absente');
  const intrus = para.match(/\b(plan|lot|raf\.yaml|carte|description)\b/i);
  if (intrus) v.push(`C1 : « ${intrus[0]} » dans le paragraphe du relecteur`);
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------
// C2, contexte découpé : une session par bras, Opus partout (sonnet et haiku interdits sous toutes leurs formes)
const ALLOWLIST_MODELES_SRC: string[] = []; // vide aujourd'hui : aucun fichier de src n'a le droit de nommer sonnet ou haiku
function reglesC2(f: Fichiers): string[] {
  const v: string[] = [];
  for (const k of briefsDe(f)) for (const m of ['nouvelle session', 'claude -p']) if (f[k].toLowerCase().includes(m)) v.push(`C2 : « ${m} » dans ${k}`);
  for (const k of [...briefsDe(f), 'docs/banc.md', ...sources(f).filter((s) => !ALLOWLIST_MODELES_SRC.includes(s))])
    if (/sonnet|haiku/i.test(f[k] ?? '')) v.push(`C2 : sonnet ou haiku dans ${k}`);
  if (!/option\(reste, 'juge'\) \?\? 'opus'/.test(f['src/bench/cli.ts'] ?? '')) v.push('C2 : le juge par défaut n\'est pas opus');
  if (!/'--resume'/.test(f['src/bench/bras.ts'] ?? '')) v.push('C2 : bras.ts ne reprend plus la session (--resume)');
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------
// C3, portes empilées. Spec §0 C3 : « Deux portes au plus : ciblée par le responsable, complète une fois à l'intégration. »
// Aucun module de porte n'existe encore (R15) : la règle est TAUTOLOGIQUE (0 site) jusqu'à sa création, à revérifier alors.
const MAX_SITES_PORTE = 2;
function reglesC3(f: Fichiers): string[] {
  const v: string[] = [];
  const sites = sources(f).flatMap((k) => {
    const t = sansChaines(sansCommentaires(f[k])).replace(/\bfunction\s+\w+\s*\(/g, '');
    return (t.match(/\b\w*(?:porte|gate|verif|verify|controle|check)\w*\s*\(/gi) ?? []).map((m) => `${k}: ${m}`);
  });
  if (sites.length > MAX_SITES_PORTE) v.push(`C3 : ${sites.length} sites de porte (${sites.join(' ; ')})`);
  const b = JSON.parse(f['budget.json']) as { modules: Record<string, number> };
  if (b.modules.porte > 250) v.push(`C3 : budget porte ${b.modules.porte} > 250`);
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------
// C4, mécanismes sans mesure : toute option lue (littéral --xxx, option(x,'xxx'), env, argv) est justifiée dans options.json
// Flags des CLI claude et git, par fichier (liste exacte ; aucune autre valeur n'est tolérée).
const FLAGS_CLI: Record<string, string[]> = {
  'src/bench/bras.ts': ['output-format', 'model', 'permission-mode', 'disallowedTools', 'resume'],
  'src/bench/juges.ts': ['output-format', 'model', 'permission-mode', 'disallowedTools', 'resume'],
  'src/bench/preparer.ts': ['no-hardlinks', 'format', 'is-ancestor', 'all', 'expire', 'prune', 'not'],
  'src/bench/ajouter.ts': ['format', 'reverse', 'grep', 'verify', 'name-only'],
  'src/bench/cli.ts': ['porcelain'], // git status --porcelain
};
const prefixe = (k: string) => (k.startsWith('src/bench/') ? 'bench' : 'cadence2');
function reglesC4(f: Fichiers, existe: (chemin: string) => boolean): string[] {
  const opts = (JSON.parse(f['options.json']) as { options: Record<string, string> }).options;
  const v: string[] = [];
  const exige = (cle: string) => {
    if (!(cle in opts)) v.push(`C4 : « ${cle} » sans justification dans options.json`);
    else if (!existe(opts[cle])) v.push(`C4 : ${opts[cle]} (pour « ${cle} ») n'existe pas`);
  };
  for (const k of sources(f)) {
    const t = sansCommentaires(f[k]);
    const flags = new Set([...t.matchAll(/(?<![\w-])--([A-Za-z][\w-]*)/g)].map((m) => m[1]));
    for (const m of t.matchAll(/option\(\s*\w+,\s*'([\w-]+)'\s*\)/g)) flags.add(m[1]);
    for (const fl of flags) if (!(FLAGS_CLI[k] ?? []).includes(fl)) exige(`${prefixe(k)} --${fl}`);
    for (const m of t.matchAll(/\b(?:process\.)?env\.(\w+)/g)) exige(`${prefixe(k)} env ${m[1]}`);
    if (/\bargv\b/.test(t)) exige(`${prefixe(k)} argv`);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------
// C5, rattrapages du lead : les critères bloquants restent bloquants (le comportement est testé plus bas, ici la forme du code)
function reglesC5(f: Fichiers): string[] {
  const t = f['src/bench/verdict.ts'] ?? '';
  const v: string[] = [];
  if (!/c\('questions inutiles', [^\n]*, inutiles === 0\),/.test(t)) v.push('C5 : « questions inutiles » n\'est plus un critère bloquant simple');
  if (!/c\('aucun bras en échec', [^\n]*, echecs\.length === 0\),/.test(t)) v.push('C5 : « aucun bras en échec » n\'est plus un critère bloquant simple');
  if (!/bloquant = true\)/.test(t)) v.push('C5 : bloquant n\'est plus vrai par défaut');
  if (!/vert: criteres\.every\(\(x\) => x\.ok \|\| !x\.bloquant\)/.test(t)) v.push('C5 : la formule du vert a changé');
  if (!/\['1', '3', '6'\]\.every/.test(t)) v.push('C5 : statut ne demande plus 1, 3 et 6');
  return v;
}

const existeReel = (p: string) => existsSync(join(depot, p));

describe('les vrais fichiers respectent les règles', () => {
  it('C1', () => expect(reglesC1(reel)).toEqual([]));
  it('C2', () => expect(reglesC2(reel)).toEqual([]));
  it('C3', () => expect(reglesC3(reel)).toEqual([]));
  it('C4', () => expect(reglesC4(reel, existeReel)).toEqual([]));
  it('C5', () => expect(reglesC5(reel)).toEqual([]));
  it('au moins une option est lue (la règle C4 ne tourne pas à vide)', () =>
    expect(Object.keys(JSON.parse(reel['options.json']).options).length).toBeGreaterThan(5));
});

// ---------------------------------------------------------------------------------------------------------------------
// Table de mutations : chaque régression connue, appliquée à une copie en mémoire, doit lever au moins une violation.
type Regle = (f: Fichiers) => string[];
const regles: Record<string, Regle> = { C1: reglesC1, C2: reglesC2, C3: reglesC3, C4: (f) => reglesC4(f, existeReel), C5: reglesC5 };
const ajout = (s: string) => (t: string) => `${t}\n${s}\n`;
const remplace = (de: string | RegExp, par: string) => (t: string) => t.replace(de, par);
const mutations: [string, string, string, (t: string) => string][] = [
  // les 14 sondes du premier passage
  ['C1', 'scellé dans un brief', 'briefs/bras-A.md', ajout('le scellé')],
  ['C1', 'spec: dans src', 'src/bench/banc.ts', ajout('// spec: x')],
  ['C1', '{{DEMANDE}} retiré', BRIEF_CAND, remplace('{{DEMANDE}}', '')],
  ['C1', 'relecteur sans diff', BRIEF_CAND, remplace('git -C {{CLONE}} diff', 'git log')],
  ['C2', 'nouvelle session', 'briefs/bras-A.md', ajout('ouvre une nouvelle session')],
  ['C2', 'juge par défaut sonnet', 'src/bench/cli.ts', remplace("?? 'opus'", "?? 'sonnet'")],
  ['C2', "modele: 'sonnet'", 'src/bench/bras.ts', ajout("const d = { modele: 'sonnet' };")],
  ['C3', 'trois portes', 'src/bench/banc.ts', ajout('porte(1);\ngate(2);\nverifyAll(3);')],
  ['C3', 'budget porte 400', 'budget.json', remplace('"porte": 250', '"porte": 400')],
  ['C4', "option(reste,'zzz') sans entrée", 'src/bench/cli.ts', remplace("option(reste, 'taille')", "option(reste, 'zzz')")],
  ['C4', 'chemin options.json inexistant', 'options.json', remplace('"bench --juge": "docs/v2/2026-11-07-cadence-2-design.md"', '"bench --juge": "docs/v2/mesures/rien.md"')],
  ['C5', 'questions inutiles non bloquant', 'src/bench/verdict.ts', remplace('inutiles === 0)', 'inutiles === 0, false)')],
  ['C5', 'aucun bras en échec non bloquant', 'src/bench/verdict.ts', remplace('echecs.length === 0)', 'echecs.length === 0, false)')],
  ['C5', 'statut sans le banc 6', 'src/bench/verdict.ts', remplace("['1', '3', '6'].every", "['1', '3'].every")],
  // déguisements essayés par le relecteur Opus
  ['C5', 'critère neutralisé par || true', 'src/bench/verdict.ts', remplace('inutiles === 0)', 'inutiles === 0 || true)')],
  ['C5', 'bloquant faux par défaut', 'src/bench/verdict.ts', remplace('bloquant = true)', 'bloquant = false)')],
  ['C2', '--model sonnet dans un brief', 'briefs/bras-A.md', ajout('lance claude --model sonnet')],
  ['C2', '"model": "Haiku" dans src', 'src/bench/juges.ts', ajout('const j = { "model": "Haiku" };')],
  ['C2', 'doc du banc en sonnet', 'docs/banc.md', ajout('modele: sonnet')],
  ['C2', 'le bras ne reprend plus la session', 'src/bench/bras.ts', remplace("'--resume'", "'--continue'")],
  ['C4', 'option entre guillemets doubles', 'src/bench/cli.ts', ajout('const x = ["--zzz"];')],
  ['C4', 'option dans un gabarit', 'src/bench/preparer.ts', ajout('const y = `--yyy`;')],
  ['C4', 'variable d\'environnement lue', 'src/bench/banc.ts', ajout('const z = process.env.CADENCE_TRUC;')],
  ['C4', 'lecture de argv', 'src/cli.ts', ajout('const a = process.argv.slice(2);')],
  ['C4', 'clé options.json au suffixe seulement', 'options.json', remplace('"bench --juge"', '"xbench --juge"')],
  ['C1', 'plan dans le paragraphe du relecteur', BRIEF_CAND, remplace('Donne-lui seulement', 'Donne-lui le plan du lot, puis seulement')],
  ['C1', 'phrase du relecteur modifiée', BRIEF_CAND, remplace('la sortie de `git -C', 'le résumé de `git -C')],
  ['C1', 'snapshot dans src', 'src/bench/fuites.ts', ajout('// snapshot de référence')],
  ['C1', 'contrat dans un brief', 'briefs/juge-aveugle.md', ajout('Respecte le contrat.')],
  ['C3', 'porte déguisée en controle', 'src/bench/banc.ts', ajout('controle(a);\ncheckAll(b);\nverif(c);')],
];
describe('mutation : chaque régression connue est détectée', () => {
  it.each(mutations)('%s : %s', (cause, _nom, fichier, muter) => {
    expect(reel[fichier], `${fichier} absent`).toBeDefined();
    const copie = { ...reel, [fichier]: muter(reel[fichier]) };
    expect(copie[fichier]).not.toBe(reel[fichier]);
    expect(regles[cause](copie).length, `${cause} : la régression n'est pas vue`).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// C5 par le comportement : une régression déguisée dans verdict.ts ne doit pas passer
describe('C5, comportement de verdict, rapport et historique', () => {
  const mes = (bras: string, questions: number, echec: string | null) =>
    ({ bras, banc: 'b', debut: '', fin: '', duree_s: 100, tokens: 1, cout_usd: 1, questions, questions_texte: [], sessions: [], echec });
  const banc = (o: { questionsC?: number; echecC?: string }): ResultatBanc => ({
    banc: 'b', taille: 'fonction', visible: false, reponses: false, frais: false,
    mesures: { A: mes('A', 0, null), C: mes('C', o.questionsC ?? 0, o.echecC ?? null) }, jugement: null, fuites: { A: [], C: [] } });
  const cas: [string, ResultatBanc][] = [['questions inutiles', banc({ questionsC: 1 })], ['aucun bras en échec', banc({ echecC: 'code 1' })]];

  it.each(cas)('« %s » : bloquant, rouge, vert faux, nommé dans le rapport et dans l\'historique', (nom, b) => {
    const v = verdict([b], 'A', 'C', BARRE_SPEC);
    expect(v.criteres.find((c) => c.nom === nom)).toMatchObject({ bloquant: true, ok: false });
    expect(v.vert).toBe(false);
    const md = rapport([b], 'A', 'C', v, { date: '2026-11-07', empreinte: 'e1' });
    for (const c of v.criteres) expect(md, `critère « ${c.nom} » absent du rapport`).toContain(c.nom);
    expect(md).toContain('**ROUGE**');
    const h = JSON.parse(ligneHistorique(v, { date: '2026-11-07T10:00:00Z', empreinte: 'e1', candidat: 'C', bancs: ['b'], hebdo: false, frais: 0 }));
    expect(h.vert).toBe(false);
    expect(h.rouges).toContain(nom);
  });
  it('statut refuse la publication sans passage couvrant 1, 3 et 6', () => {
    const ligne = (bancs: string[]) => JSON.stringify({ date: '2026-11-07T10:00:00Z', empreinte: 'e1', vert: true, hebdo: false, frais: 0, bancs });
    const now = new Date('2026-11-07T12:00:00Z');
    expect(statut([ligne(['1-a', '3-b'])], now, 'e1').publication_ok).toBe(false);
    expect(statut([ligne(['1-a', '3-b', '6-c'])], now, 'e1').publication_ok).toBe(true);
  });
});

describe('C2, une seule session par bras', () => {
  it('les appels suivants reprennent la session du premier (--resume), sans nouvelle session', () => {
    const r = mkdtempSync(join(tmpdir(), 'rechute-'));
    const dir = join(r, 'bancs', '1-t'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'demande.md'), 'Ajoute un séparateur.'); writeFileSync(join(dir, 'reponses.md'), 'Oui.');
    const clone = join(r, 'runs', 'A'); mkdirSync(clone, { recursive: true });
    const b: Banc = { id: '1-t', dir, secrets: join(r, 's'), projet: 't', source: '/s', base: 'abc1234', install: 'true', tests: 'true',
      visible: false, taille: 'retouche', frais: false, reponses: true };
    const appels: string[][] = [];
    const exec: Executeur = (args) => {
      appels.push(args);
      if (appels.length <= 2) writeFileSync(`${clone}.question.md`, '?');
      return { stdout: JSON.stringify({ session_id: 's1', total_cost_usd: 0, modelUsage: {} }), code: 0 };
    };
    const m = lancerBras(b, { nom: 'A', modele: 'opus', brief: join(v2, 'briefs', 'bras-A.md') }, clone, exec);
    expect(appels.length).toBe(3);
    expect(appels[0]).not.toContain('--resume');
    for (const a of appels.slice(1)) expect(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2)).toEqual(['--resume', 's1']);
    expect(m.sessions).toEqual(['s1']);
  });
});
