import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lireDemande, type Banc } from './banc.js';
import { environnementNeutre, OUTILS_INTERDITS, type Executeur } from './bras.js';

/** R35 : sortie attendue cachée d'une séquence (étape k), jugée sur l'application de l'état final. */ export interface Sortie { k: number; sortie: string }
export interface Meca { suite_ok: boolean; caches_passes: number; caches_total: number; mutations_tuees: number; mutations_total: number;
  attendu: 'oui' | 'en partie' | 'non'; mutations: { ou: string; quoi: string; tuee: boolean }[]; sorties?: (Sortie & { i: number; verdict: 'oui' | 'non' | 'incertain'; preuve: string })[] }
export interface Defauts { bloquants: number; majeurs: number; mineurs: number }
/** `remplaces` (R28, R30) : tests cachés remplacés par une demande ultérieure, une liste UNIQUE décidée avant X et Y, non comptée pour les deux. */
/** R39 : `prefere` et `ui` valent « indécis » quand les deux ordres du juge aveugle se contredisent ; `defauts` = max des deux ordres. */
export interface Jugement { meca: Record<string, Meca>; remplaces?: string[]; defauts: Record<string, Defauts>; prefere: string; ui: string; raisons: string;
  /** m2 : X et Y → bras, pour vérifier les preuves (captures-sorties-X/…). */ anonymat?: Record<'X' | 'Y', string>; aveugle_ordres?: Ordre[] }
type Avis = { X: Defauts; Y: Defauts; prefere: string; ui: string; raisons: string };
/** Un passage du juge aveugle, `prefere` et `ui` ramenés aux noms des bras. */ export type Ordre = Avis & { anonymat: Record<'X' | 'Y', string> };

const BRIEFS = join(import.meta.dirname, '..', '..', 'briefs');
const HORS_DIFF = [':(exclude).cadence', ':(exclude)docs/plan', ':(exclude)cadence.yaml', ':(exclude).playwright-mcp']; // .playwright-mcp : captures du serveur MCP Playwright (S7)

/** HEAD et fichiers sales d'un clone, hors fichiers de cadence (les juges ne voient que base..HEAD). */
export function etatGit(clone: string): { head: string; sale: string[] } {
  const g = (...a: string[]) => execFileSync('git', a, { cwd: clone, encoding: 'utf8' });
  return { head: g('rev-parse', 'HEAD').trim(), sale: g('status', '--porcelain', '--', '.', ...HORS_DIFF).split('\n').filter(Boolean) };
}
/** Un bras doit livrer par commit : un travail non commité ou l'absence de commit est un échec (le juge serait injuste). */
export function travailNonLivre(avant: { head: string; sale: string[] }, apres: { head: string; sale: string[] }): string | null {
  if (apres.sale.some((l) => !avant.sale.includes(l))) return 'travail non commité';
  return apres.head === avant.head ? 'aucun commit' : null;
}

/** R39 : un avis ne compte que s'il désigne la même chose dans les deux ordres, sinon « indécis » ; défauts par bras au max (échec fermé). */
export function combiner(p: Ordre[]): Pick<Jugement, 'defauts' | 'prefere' | 'ui' | 'raisons' | 'aveugle_ordres'> {
  const o = p.map((x) => ({ ...x, prefere: nom(x.anonymat, x.prefere), ui: nom(x.anonymat, x.ui) }));
  const accord = (f: 'prefere' | 'ui') => (o.every((x) => x[f] === o[0][f]) ? o[0][f] : 'indécis');
  const max = (b: string) => Object.fromEntries((['bloquants', 'majeurs', 'mineurs'] as const).map((f) => [f, Math.max(...o.map((x) => x[x.anonymat.X === b ? 'X' : 'Y'][f]))])) as unknown as Defauts;
  return { defauts: Object.fromEntries(Object.values(p[0].anonymat).map((b) => [b, max(b)])), prefere: accord('prefere'), ui: accord('ui'),
    raisons: o.map((x, i) => `ordre ${i + 1} (X = ${x.anonymat.X}) : ${x.raisons}`).join(' '), aveugle_ordres: o };
}
const nom = (a: Record<'X' | 'Y', string>, x: string) => (x === 'X' || x === 'Y' ? a[x] : x);
/** Avis lisible au rapport : « indécis (A dans un ordre, cand dans l'autre) ». */
export const avisLu = (j: Jugement, f: 'prefere' | 'ui'): string => (j[f] === 'indécis' ? `indécis (${(j.aveugle_ordres ?? []).map((x) => x[f]).join(' dans un ordre, ')} dans l'autre)` : j[f]);
export const anonymiser = (bras: [string, string], tirage: () => number): Record<'X' | 'Y', string> => (tirage() < 0.5 ? { X: bras[0], Y: bras[1] } : { X: bras[1], Y: bras[0] });
const entier = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
export function validerMeca(o: unknown, attendues: Sortie[] = []): string[] {
  const e: string[] = [];
  for (const k of ['X', 'Y'] as const) {
    const m = (o as Record<string, Meca> | null)?.[k];
    if (!m) { e.push(`${k} manquant`); continue; }
    for (const f of ['caches_passes', 'caches_total', 'mutations_tuees', 'mutations_total'] as const) if (!entier(m[f])) e.push(`${k}.${f} n'est pas un entier ≥ 0`);
    if (m.caches_passes > m.caches_total) e.push(`${k}.caches_passes > caches_total`);
    if (m.mutations_tuees > m.mutations_total) e.push(`${k}.mutations_tuees > mutations_total`);
    if (typeof m.suite_ok !== 'boolean') e.push(`${k}.suite_ok n'est pas un booléen`);
    if (!['oui', 'en partie', 'non'].includes(m.attendu)) e.push(`${k}.attendu doit valoir oui, en partie ou non`);
    // R38 : rendues par index {i, verdict, preuve}, i = 1..n exactement, dans l'ordre ; le code rattache k et le texte
    const is = Array.isArray(m.sorties) ? m.sorties.map((x) => x?.i) : [], n = attendues.map((_, j) => j + 1), manquants = n.filter((i) => !is.includes(i));
    if (attendues.length && JSON.stringify(is) !== JSON.stringify(n)) e.push(`${k}.sorties : i attendus [${n.join(', ')}] dans l'ordre, sans doublon ; reçus [${is.join(', ')}]${manquants.length ? ` (manquants : ${manquants.join(', ')})` : ''}`);
    else for (const x of attendues.length ? m.sorties! : []) {
      if (!['oui', 'non', 'incertain'].includes(x.verdict)) e.push(`${k}.sorties[i=${x.i}].verdict doit valoir oui, non ou incertain`);
      else if (typeof x.preuve !== 'string' || !x.preuve.trim()) e.push(`${k}.sorties[i=${x.i}].preuve vide`);
    }
  }
  const r = (o as { remplaces?: unknown } | null)?.remplaces;
  if (!Array.isArray(r) || r.some((t) => typeof t !== 'string')) e.push('remplaces n\'est pas une liste de textes');
  return e;
}

export function validerAveugle(o: unknown): string[] {
  const a = o as Record<string, unknown> | null; const e: string[] = [];
  for (const k of ['X', 'Y']) {
    const d = a?.[k] as Defauts | undefined;
    if (!d || !entier(d.bloquants) || !entier(d.majeurs) || !entier(d.mineurs)) e.push(`${k} : bloquants, majeurs, mineurs entiers attendus`);
  }
  if (!['X', 'Y', 'egal'].includes(a?.prefere as string)) e.push('prefere doit valoir X, Y ou egal');
  if (!['X', 'Y', 'egal', 'na'].includes(a?.ui as string)) e.push('ui doit valoir X, Y, egal ou na');
  return e;
}

const remplir = (gabarit: string, v: Record<string, string>): string => Object.entries(v).reduce((t, [k, x]) => t.replaceAll(`{{${k}}}`, x), readFileSync(join(BRIEFS, gabarit), 'utf8'));

/** Une session claude : { ok, session } ; jamais d'exception sur la sortie de claude (R7). */
function appeler(exec: Executeur, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }): { ok: boolean; session: string } {
  const e = exec(args, o);
  try {
    const j = JSON.parse(e.stdout) as { session_id?: string; is_error?: boolean };
    return { ok: !j.is_error && e.code === 0, session: j.session_id ?? '' };
  } catch { return { ok: false, session: '' }; }
}

/** Un juge : une session, une relance (--resume) avec les erreurs si le JSON est invalide ou la session en échec, puis null. */
function demander(brief: string, sortie: string, valider: (o: unknown) => string[], cwd: string, modele: string, exec: Executeur): unknown {
  const commun = ['--output-format', 'json', '--model', modele, '--permission-mode', 'bypassPermissions', '--disallowedTools', OUTILS_INTERDITS.join(',')];
  const o = { cwd, env: environnementNeutre(process.env) };
  let { ok, session } = appeler(exec, ['-p', brief, ...commun], o);
  for (let essai = 0; essai < 2; essai++) {
    let res: unknown = null;
    if (ok) try { res = JSON.parse(readFileSync(sortie, 'utf8')); } catch { /* absent ou illisible */ }
    const erreurs = !ok ? ['session claude en échec'] : res === null ? ['fichier absent ou JSON illisible'] : valider(res);
    if (erreurs.length === 0) return res;
    if (essai === 1 || !session) return null;
    ({ ok, session } = appeler(exec, ['-p', `Ton JSON dans ${sortie} est invalide : ${erreurs.join(' ; ')}. Réécris-le, rien d'autre.`, '--resume', session, ...commun], o));
  }
  return null;
}

/** `demandes` : liste des demandes d'une séquence (champ {{DEMANDES}} des briefs), vide pour un banc ; `sorties` : sorties attendues cachées (R35), vide pour un banc. */
export function juger(b: Banc, clones: Record<string, string>, dirEval: string, modele: string, exec: Executeur, tirage = Math.random, demandes = '', sorties: Sortie[] = []): Jugement | null {
  const noms = Object.keys(clones) as [string, string];
  const anon = anonymiser(noms, tirage);
  rmSync(dirEval, { recursive: true, force: true }); mkdirSync(dirEval, { recursive: true });
  writeFileSync(join(dirEval, 'demande.md'), lireDemande(b));
  const copier = (a: Record<'X' | 'Y', string>): boolean => {
    for (const k of ['X', 'Y'] as const) {
      try {
        writeFileSync(join(dirEval, `${k}.patch`), execFileSync('git', ['diff', `${b.base}..HEAD`, '--', '.', ...HORS_DIFF], { cwd: clones[a[k]], encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }));
      } catch { return false; }
      rmSync(join(dirEval, k), { recursive: true, force: true });
      cpSync(clones[a[k]], join(dirEval, k), { recursive: true });
      rmSync(join(dirEval, k, '.git'), { recursive: true, force: true }); // la copie ne doit pas trahir le bras
    }
    return true;
  };
  try {
    if (!copier(anon)) return null;
    const v = { EVAL: dirEval, SECRETS: b.secrets, MESURE: join(b.secrets, 'mesure.md'), TESTS: b.tests, DEMANDES: demandes }, sMeca = join(dirEval, 'meca.json');
    const so = sorties.length ? '\n' + remplir('juge-sorties.md', { ...v, LISTE: sorties.map((x, i) => `S${i + 1} (i=${i + 1}). étape ${x.k} : ${x.sortie}`).join('\n') }).trimEnd() : '';
    const meca = demander(remplir('juge-mecanique.md', { ...v, SORTIE: sMeca, SORTIES: so }), sMeca, (x) => validerMeca(x, sorties), dirEval, modele, exec) as (Record<'X' | 'Y', Meca> & { remplaces: string[] }) | null;
    if (!meca) return null;
    for (const m of sorties.length ? [meca.X, meca.Y] : []) m.sorties = m.sorties!.map((x, j) => ({ ...sorties[j], i: x.i, verdict: x.verdict, preuve: x.preuve }));
    const ecran = (s: string) => (b.visible
      ? `Lance l'app de chaque copie, l'une après l'autre, comme le dit ${v.MESURE} (section Écran). Fais des captures à 1440 et à 390 px dans ${dirEval}/captures${s}-X et captures${s}-Y, et regarde-les. ui = la copie dont l'écran est le plus cohérent avec le reste de l'application.`
      : 'Pas d\'écran : ui = "na".');
    const ordres: Ordre[] = [];
    for (const [a, s] of [[anon, ''], [{ X: anon.Y, Y: anon.X }, '-2']] as const) { // R39 : second passage à ordre permuté (biais de position)
      if (!copier(a)) return null; // le juge à l'aveugle voit les livrables, pas les mutations
      const f = join(dirEval, `aveugle${s}.json`), av = demander(remplir('juge-aveugle.md', { ...v, ECRAN: ecran(s), SORTIE: f }), f, validerAveugle, dirEval, modele, exec) as Avis | null;
      if (!av) return null;
      ordres.push({ ...av, anonymat: a });
    }
    return { meca: { [anon.X]: meca.X, [anon.Y]: meca.Y }, remplaces: meca.remplaces, ...combiner(ordres), anonymat: anon };
  } finally { for (const k of ['X', 'Y']) rmSync(join(dirEval, k), { recursive: true, force: true }); } // copies effacées sur tous les chemins
}
