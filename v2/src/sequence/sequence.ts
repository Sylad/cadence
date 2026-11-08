import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { BancInvalide } from '../bench/banc.js';

export type TailleEtape = 'retouche' | 'fonction';
export interface Etape { k: number; lot: string; demande: string; pieces: string[]; taille: TailleEtape }
export interface Cache { fichiers: string[]; commande: string }
export interface Sequence { id: string; dir: string; secrets: string; projet: string; source: string; base: string;
  install: string; tests: string; etapes: Etape[]; caches: Record<number, Cache>;
  regression: { a_partir_de: number; fichiers: string[]; commande: string } }

const TAILLES: TailleEtape[] = ['retouche', 'fonction'];
const REQUIS = ['projet', 'source', 'base', 'install', 'tests'] as const;
type Obj = Record<string, unknown>;

const lire = (f: string): Obj => (parse(readFileSync(f, 'utf8')) ?? {}) as Obj;
const texte = (v: unknown): v is string => typeof v === 'string' && v !== '';
const liste = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => texte(x)) ? (v as string[]) : null);

export function chargerSequence(racine: string, id: string): Sequence {
  const ko = (m: string): never => { throw new BancInvalide(`séquence ${id} : ${m}`); };
  const dir = join(racine, 'sequences', id);
  const secrets = join(racine, 'secrets', 'sequences', id);
  const y = lire(join(dir, 'sequence.yaml'));
  for (const k of REQUIS) if (!texte(y[k])) ko(`champ « ${k} » manquant`);
  const brutes = Array.isArray(y.etapes) ? (y.etapes as Obj[]) : [];
  if (!brutes.length) ko('champ « etapes » manquant ou vide');
  const abs = (base: string, p: string) => (isAbsolute(p) ? p : join(base, p));
  const etapes = brutes.map((e, i): Etape => {
    if (e?.k !== i + 1) ko(`étape ${i + 1} : « k » doit valoir ${i + 1} (étapes numérotées 1..${brutes.length})`);
    if (!texte(e.lot)) ko(`étape ${i + 1} : champ « lot » manquant`);
    if (!texte(e.demande) || !existsSync(abs(dir, e.demande))) ko(`étape ${i + 1} : demande « ${String(e.demande)} » absente`);
    if (!TAILLES.includes(e.taille as TailleEtape)) ko(`étape ${i + 1} : taille « ${String(e.taille)} » inconnue (${TAILLES.join(', ')})`);
    const pieces = (e.pieces === undefined ? [] : liste(e.pieces)) ?? ko(`étape ${i + 1} : « pieces » doit être une liste de chemins`);
    const chemins = pieces.map((p) => abs(dir, p));
    for (const [j, c] of chemins.entries()) if (!existsSync(c)) ko(`étape ${i + 1} : pièce « ${pieces[j]} » absente`);
    return { k: i + 1, lot: e.lot as string, demande: abs(dir, e.demande as string), pieces: chemins, taille: e.taille as TailleEtape };
  });

  const s = lire(join(secrets, 'sequence-secrets.yaml'));
  const fichiers = (ou: string, v: unknown, cmd: unknown): Cache => {
    const l = liste(v) ?? ko(`${ou} : « fichiers » doit être une liste`);
    if (!texte(cmd)) ko(`${ou} : « commande » manquante`);
    const chemins = l.map((f) => join(secrets, f));
    for (const [j, c] of chemins.entries()) if (!existsSync(c)) ko(`${ou} : fichier caché « ${l[j]} » absent`);
    return { fichiers: chemins, commande: cmd as string };
  };
  const bruts = (s.caches ?? {}) as Record<string, Obj>;
  const caches: Record<number, Cache> = {};
  for (const e of etapes) {
    const c = bruts[String(e.k)];
    if (!c) ko(`caches : étape ${e.k} sans tests cachés`);
    caches[e.k] = fichiers(`caches ${e.k}`, c.fichiers, c.commande);
  }
  const r = s.regression as Obj | undefined;
  if (!r) ko('champ « regression » manquant');
  const a = (r as Obj).a_partir_de;
  if (!Number.isInteger(a) || (a as number) < 1 || (a as number) > etapes.length) ko(`regression : « a_partir_de » doit être entre 1 et ${etapes.length}`);
  const reg = fichiers('regression', (r as Obj).fichiers, (r as Obj).commande);
  return { id, dir, secrets, projet: y.projet as string, source: y.source as string, base: y.base as string,
    install: y.install as string, tests: y.tests as string, etapes, caches, regression: { a_partir_de: a as number, ...reg } };
}
