import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lireDemande, type Banc } from './banc.js';
import { environnementNeutre, OUTILS_INTERDITS, type Executeur } from './bras.js';

export interface Meca { suite_ok: boolean; caches_passes: number; caches_total: number; mutations_tuees: number; mutations_total: number;
  attendu: 'oui' | 'en partie' | 'non'; mutations: { ou: string; quoi: string; tuee: boolean }[] }
export interface Defauts { bloquants: number; majeurs: number; mineurs: number }
export interface Jugement { meca: Record<string, Meca>; defauts: Record<string, Defauts>; prefere: string; ui: string; raisons: string }

const BRIEFS = join(import.meta.dirname, '..', '..', 'briefs');
const HORS_DIFF = [':(exclude).cadence', ':(exclude)docs/plan', ':(exclude)cadence.yaml'];

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

export const anonymiser = (bras: [string, string], tirage: () => number): Record<'X' | 'Y', string> =>
  tirage() < 0.5 ? { X: bras[0], Y: bras[1] } : { X: bras[1], Y: bras[0] };

const entier = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

export function validerMeca(o: unknown): string[] {
  const e: string[] = [];
  for (const k of ['X', 'Y'] as const) {
    const m = (o as Record<string, Meca> | null)?.[k];
    if (!m) { e.push(`${k} manquant`); continue; }
    for (const f of ['caches_passes', 'caches_total', 'mutations_tuees', 'mutations_total'] as const) if (!entier(m[f])) e.push(`${k}.${f} n'est pas un entier ≥ 0`);
    if (m.caches_passes > m.caches_total) e.push(`${k}.caches_passes > caches_total`);
    if (m.mutations_tuees > m.mutations_total) e.push(`${k}.mutations_tuees > mutations_total`);
    if (typeof m.suite_ok !== 'boolean') e.push(`${k}.suite_ok n'est pas un booléen`);
    if (!['oui', 'en partie', 'non'].includes(m.attendu)) e.push(`${k}.attendu doit valoir oui, en partie ou non`);
  }
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

function remplir(gabarit: string, v: Record<string, string>): string {
  return Object.entries(v).reduce((t, [k, x]) => t.replaceAll(`{{${k}}}`, x), readFileSync(join(BRIEFS, gabarit), 'utf8'));
}

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

export function juger(b: Banc, clones: Record<string, string>, dirEval: string, modele: string, exec: Executeur, tirage = Math.random): Jugement | null {
  const noms = Object.keys(clones) as [string, string];
  const anon = anonymiser(noms, tirage);
  rmSync(dirEval, { recursive: true, force: true }); mkdirSync(dirEval, { recursive: true });
  writeFileSync(join(dirEval, 'demande.md'), lireDemande(b));
  const copier = (): boolean => {
    for (const k of ['X', 'Y'] as const) {
      try {
        writeFileSync(join(dirEval, `${k}.patch`), execFileSync('git', ['diff', `${b.base}..HEAD`, '--', '.', ...HORS_DIFF], { cwd: clones[anon[k]], encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }));
      } catch { return false; }
      rmSync(join(dirEval, k), { recursive: true, force: true });
      cpSync(clones[anon[k]], join(dirEval, k), { recursive: true });
      rmSync(join(dirEval, k, '.git'), { recursive: true, force: true }); // la copie ne doit pas trahir le bras
    }
    return true;
  };
  try {
    if (!copier()) return null;
    const v = { EVAL: dirEval, SECRETS: b.secrets, MESURE: join(b.secrets, 'mesure.md'), TESTS: b.tests };
    const sMeca = join(dirEval, 'meca.json');
    const meca = demander(remplir('juge-mecanique.md', { ...v, SORTIE: sMeca }), sMeca, validerMeca, dirEval, modele, exec) as Record<'X' | 'Y', Meca> | null;
    if (!copier()) return null; // le juge à l'aveugle voit les livrables, pas les mutations
    const ecran = b.visible
      ? `Lance l'app de chaque copie, l'une après l'autre, comme le dit ${v.MESURE} (section Écran). Fais des captures à 1440 et à 390 px dans ${dirEval}/captures-X et captures-Y, et regarde-les. ui = la copie dont l'écran est le plus cohérent avec le reste de l'application.`
      : 'Pas d\'écran : ui = "na".';
    const sAv = join(dirEval, 'aveugle.json');
    const av = demander(remplir('juge-aveugle.md', { ...v, ECRAN: ecran, SORTIE: sAv }), sAv, validerAveugle, dirEval, modele, exec) as
      { X: Defauts; Y: Defauts; prefere: string; ui: string; raisons: string } | null;
    if (!meca || !av) return null;
    const nom = (x: string) => (x === 'X' || x === 'Y' ? anon[x] : x);
    return {
      meca: { [anon.X]: meca.X, [anon.Y]: meca.Y }, defauts: { [anon.X]: av.X, [anon.Y]: av.Y },
      prefere: nom(av.prefere), ui: nom(av.ui), raisons: av.raisons,
    };
  } finally { for (const k of ['X', 'Y']) rmSync(join(dirEval, k), { recursive: true, force: true }); } // copies effacées sur tous les chemins
}
