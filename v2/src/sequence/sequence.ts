import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { BancInvalide } from '../bench/banc.js';
import type { Sortie } from '../bench/juges.js';

export type TailleEtape = 'retouche' | 'fonction';
/** `references_depot` : documents présents dans le clone (relatifs au dépôt), à lire comme les pièces. */
export interface Etape { k: number; lot: string; demande: string; pieces: string[]; references_depot: string[]; taille: TailleEtape }
export interface Cache { fichiers: string[]; commande: string }
export interface Sequence { id: string; dir: string; secrets: string; projet: string; source: string; base: string;
  install: string; tests: string; visible: boolean; suite_projet: { vitest_json: string; build: string; portee: string }; etapes: Etape[]; caches: Record<number, Cache>;
  regression: { a_partir_de: number; fichiers: string[]; commande: string }; /** R35 : sorties attendues cachées, dans l'ordre des étapes ([] : aucune). */ sorties: Sortie[] }

const TAILLES: TailleEtape[] = ['retouche', 'fonction'];
const REQUIS = ['projet', 'source', 'base', 'install', 'tests'] as const;
type Obj = Record<string, unknown>;

const dedans = (base: string, c: string) => { const r = relative(resolve(base), resolve(c)); return r !== '' && r !== '..' && !r.startsWith('..' + '/') && !isAbsolute(r); };
const texte = (v: unknown): v is string => typeof v === 'string' && v !== '';
const liste = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => texte(x)) ? (v as string[]) : null);

export function chargerSequence(racine: string, id: string): Sequence {
  const ko = (m: string): never => { throw new BancInvalide(`séquence ${id} : ${m}`); };
  const lire = (f: string): Obj => {
    if (!existsSync(f)) ko(`fichier ${f} absent`);
    try { return (parse(readFileSync(f, 'utf8')) ?? {}) as Obj; } catch (e) { return ko(`YAML invalide dans ${f} (${(e as Error).message.split('\n')[0]})`); }
  };
  const dir = join(racine, 'sequences', id);
  const secrets = join(racine, 'secrets', 'sequences', id);
  const y = lire(join(dir, 'sequence.yaml'));
  for (const k of REQUIS) if (!texte(y[k])) ko(`champ « ${k} » manquant`);
  if (!existsSync(y.source as string) || !statSync(y.source as string).isDirectory()) ko(`« source » ${String(y.source)} n'est pas un dossier existant`);
  const sp = (y.suite_projet ?? {}) as Obj;
  if (!texte(sp.vitest_json) || !sp.vitest_json.includes('<sortie>') || !texte(sp.build)) ko('« suite_projet » : vitest_json (avec <sortie>) et build requis');
  const dossier = /^cd (\S+) &&/.exec(sp.vitest_json as string)?.[1]; // portée affichée par étape : ce que la suite ne voit pas, seul le juge final le voit
  const portee = texte(sp.portee) ? sp.portee : `Suite mesurée : ${dossier ? `${dossier} uniquement (le reste du dépôt est vu par le juge final)` : 'tout le dépôt'}`;
  const brutes = Array.isArray(y.etapes) ? (y.etapes as Obj[]) : [];
  if (!brutes.length) ko('champ « etapes » manquant ou vide');
  const abs = (base: string, p: string) => (isAbsolute(p) ? p : join(base, p));
  const public_ = (ou: string, p: string) => { const c = abs(dir, p); return dedans(dir, c) ? c : ko(`${ou} « ${p} » sort du dossier de la séquence`); };
  const etapes = brutes.map((e, i): Etape => {
    if (e?.k !== i + 1) ko(`étape ${i + 1} : « k » doit valoir ${i + 1} (étapes numérotées 1..${brutes.length})`);
    if (!texte(e.lot)) ko(`étape ${i + 1} : champ « lot » manquant`);
    if (!texte(e.demande)) ko(`étape ${i + 1} : champ « demande » manquant`);
    const dem = public_(`étape ${i + 1} : demande`, e.demande as string);
    if (basename(dem) !== 'demande.md' || dirname(dem) === dir) ko(`étape ${i + 1} : la demande doit être <dossier de l'étape>/demande.md`);
    if (!existsSync(dem)) ko(`étape ${i + 1} : demande « ${String(e.demande)} » absente`);
    if (!TAILLES.includes(e.taille as TailleEtape)) ko(`étape ${i + 1} : taille « ${String(e.taille)} » inconnue (${TAILLES.join(', ')})`);
    const pieces = (e.pieces === undefined ? [] : liste(e.pieces)) ?? ko(`étape ${i + 1} : « pieces » doit être une liste de chemins`);
    const chemins = pieces.map((p) => public_(`étape ${i + 1} : pièce`, p));
    for (const [j, c] of chemins.entries()) if (!existsSync(c)) ko(`étape ${i + 1} : pièce « ${pieces[j]} » absente`);
    const refs = (e.references_depot === undefined ? [] : liste(e.references_depot)) ?? ko(`étape ${i + 1} : « references_depot » doit être une liste`);
    for (const x of refs) if (isAbsolute(x) || x.split('/').includes('..')) ko(`étape ${i + 1} : référence « ${x} » hors du dépôt`);
    return { k: i + 1, lot: e.lot as string, demande: dem, pieces: chemins, references_depot: refs, taille: e.taille as TailleEtape };
  });

  const s = lire(join(secrets, 'sequence-secrets.yaml'));
  const fichiers = (ou: string, v: unknown, cmd: unknown): Cache => {
    const l = liste(v) ?? ko(`${ou} : « fichiers » doit être une liste`);
    if (!texte(cmd)) ko(`${ou} : « commande » manquante`);
    if (!l.length) ko(`${ou} : « fichiers » vide (rien à mesurer)`);
    const chemins = l.map((f) => { const c = abs(secrets, f); return dedans(secrets, c) ? c : ko(`${ou} : fichier caché « ${f} » sort du dossier des secrets`); });
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
  for (const k of Object.keys(bruts)) if (!etapes.some((e) => String(e.k) === k)) ko(`caches : clé « ${k} » hors des étapes 1..${etapes.length}`);
  const r = s.regression as Obj | undefined;
  if (!r) ko('champ « regression » manquant');
  const a = (r as Obj).a_partir_de;
  if (!Number.isInteger(a) || (a as number) < 1 || (a as number) > etapes.length) ko(`regression : « a_partir_de » doit être entre 1 et ${etapes.length}`);
  const reg = fichiers('regression', (r as Obj).fichiers, (r as Obj).commande);
  const so = ('sorties' in s ? s.sorties : {}) as Record<string, unknown>; // m5 : présente, nulle ou d'un autre type = refusée
  if (!so || typeof so !== 'object' || Array.isArray(so)) ko('« sorties » doit associer une étape à une liste de sorties');
  for (const k of Object.keys(so)) if (!etapes.some((e) => String(e.k) === k)) ko(`sorties : clé « ${k} » hors des étapes 1..${etapes.length}`);
  const sorties = etapes.flatMap((e) => (so[e.k] === undefined ? [] : liste(so[e.k])?.length ? liste(so[e.k])! : ko(`sorties ${e.k} : liste de textes non vides attendue`)).map((sortie) => ({ k: e.k, sortie })));
  const mesure = join(secrets, 'mesure.md'); // B1 : le juge lance l'app des copies comme le dit sa section Écran (sinon `npm start` peut viser la prod)
  if (sorties.length && !(existsSync(mesure) && /^#+ .*Écran/m.test(readFileSync(mesure, 'utf8')))) ko(`sorties déclarées : ${mesure} avec une section « Écran » (titre) requis, pour lancer l'app des copies`);
  return { id, dir, secrets, projet: y.projet as string, source: y.source as string, base: y.base as string,
    install: y.install as string, tests: y.tests as string, visible: y.visible === true, suite_projet: { vitest_json: sp.vitest_json as string, build: sp.build as string, portee }, etapes, caches, regression: { a_partir_de: a as number, ...reg }, sorties };
}
