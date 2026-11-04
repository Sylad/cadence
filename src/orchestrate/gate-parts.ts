// Porte de tests déclarée en parties (L512) : `orchestrate.test: [{ dir, run, replay? }]`. Le 31-10, la porte composée de warhammer (`backend && frontend`) refusait `testReplay`,
// donc ni le rejeu seul (L354) ni le délai trop juste et le rouge au départ (L510) : quatre corrections et une escalade pour des faux rouges (L61). Décision de Sylvain du 01-11 :
// cadence lance chaque partie séparément, dans son dossier, et attribue chaque rouge à la partie qui l'a imprimé ; une partie sans `replay` garde ses rouges comptés ; la forme chaîne reste telle quelle.
// Ce module ne change que le lieu du lancement et l'attribution des noms : les règles de verdict (deux rejeux, fichier vu dans la sortie, délai trop juste) restent celles de workers.ts.

import { isAbsolute, posix } from 'node:path';
import { failedTests, hasUnnamedFailure } from './baseline.js';
import { isComposedGate, redAlone, replayRed, shellArg, type TightTest } from './workers.js';

/** Une partie de la porte : son dossier (relatif au dépôt), sa commande, et la commande de rejeu seul où `{files}` devient les fichiers rouges qu'elle a imprimés. */
export interface GatePart {
  dir: string;
  run: string;
  replay?: string;
}

/** `orchestrate.test` : une commande (comme avant) ou une liste de parties. */
export type GateTest = string | GatePart[];

export type Runner = (command: string) => Promise<{ code: number; output: string }>;

/** Le résultat d'une partie : ce que son lanceur a imprimé, d'où ses rouges sont lus. */
export interface PartRan {
  part: GatePart;
  code: number;
  output: string;
}

/** Le résultat d'une porte : code et sortie fusionnée ; `parts` quand la porte est en parties (absent pour la forme chaîne). */
export interface GateRan {
  code: number;
  output: string;
  parts?: PartRan[];
}

export const isParts = (t: GateTest | undefined): t is GatePart[] => Array.isArray(t);

const PART_KEYS = ['dir', 'run', 'replay'];

/** Le dossier d'une partie, normalisé (`./front/` → `front`) ; null s'il est vide, absolu ou contient « .. ». */
function partDir(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim() || isAbsolute(v.trim()) || v.split(/[\\/]/).includes('..')) return null;
  const n = posix.normalize(v.trim().replaceAll('\\', '/')).replace(/\/+$/, '');
  return n || null;
}

/** Lecture de `orchestrate.test` (contrat A1) : la chaîne telle quelle, ou la liste des parties validées ; `bad` fabrique l'erreur de cadence.yaml. */
export function readGateTest(raw: unknown, bad: (what: string) => Error): GateTest {
  if (typeof raw === 'string') {
    if (!raw.trim()) throw bad('test : commande non vide attendue');
    return raw.trim();
  }
  if (!Array.isArray(raw)) throw bad('test : commande non vide attendue (chaîne ou liste de parties { dir, run, replay? })');
  if (!raw.length) throw bad('test : au moins une partie attendue (dir, run, replay facultatif)');
  const seen = new Set<string>();
  return raw.map((item): GatePart => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw bad('test : chaque partie doit être un objet { dir, run, replay? }');
    const o = item as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!PART_KEYS.includes(k)) throw bad(`test : clé « ${k} » inconnue dans une partie (attendu : dir, run, replay)`);
    const dir = partDir(o.dir);
    if (dir === null || seen.has(dir)) throw bad(`test : dir invalide « ${typeof o.dir === 'string' ? o.dir : JSON.stringify(o.dir)} » (chemin relatif, sans « .. », unique)`);
    seen.add(dir);
    if (typeof o.run !== 'string' || !o.run.trim()) throw bad(`test : la commande run de la partie « ${dir} » ne peut pas être vide (chaîne non vide attendue)`);
    const part: GatePart = { dir, run: o.run.trim() };
    if (o.replay != null) {
      if (typeof o.replay !== 'string' || !o.replay.trim() || !o.replay.includes('{files}')) throw bad(`test : le replay de la partie « ${dir} » doit être une commande non vide contenant {files} (remplacé par les fichiers des tests rouges)`);
      part.replay = o.replay.trim();
    }
    return part;
  });
}

/** `orchestrate.testReplay` face à `orchestrate.test` (L354, L512) : `{files}` exigé ; refusé avec une liste de parties (le rejeu se déclare par partie) et sur une porte composée en chaîne. */
export function checkTestReplay(test: GateTest | undefined, replay: string | undefined, bad: (what: string) => Error): void {
  if (!replay) return;
  if (!replay.includes('{files}')) throw bad('testReplay : la commande doit contenir {files} (remplacé par les fichiers des tests rouges)');
  if (isParts(test)) throw bad('testReplay : refusé quand orchestrate.test est une liste de parties : déclarer replay dans chaque partie');
  if (test && isComposedGate(test)) throw bad('testReplay : refusé quand orchestrate.test est une porte composée (&&, ||, sous-shell) : le rejeu seul ne vaut que pour un lanceur unique');
}

/** `orchestrate.testRelated` face à `orchestrate.test` (L590) : `{files}` exigé ; refusé avec une liste de parties (les fichiers n'atteindraient qu'une partie) ; accepté avec une porte composée, la commande liée étant alors la seule jouée en ciblé. */
export function checkTestRelated(test: GateTest | undefined, related: string | undefined, bad: (what: string) => Error): void {
  if (!related) return;
  if (!related.includes('{files}')) throw bad('testRelated : la commande doit contenir {files} (remplacé par les fichiers modifiés du lot)');
  if (isParts(test)) throw bad('testRelated : refusé quand orchestrate.test est une liste de parties : le lot ne joue alors que la suite complète');
}

/** `[npx ]vitest run[ options]` : l'unique forme dont la commande liée se dérive (L590, R13) ; les options n'ont ni `;`, `|`, `&`, redirection ni accent grave (`isComposedGate` écarte déjà `&&`, `||` et les parenthèses). */
const VITEST_RUN = /^(npx\s+)?vitest\s+run(?:\s+([^\s;|&<>`][^;|&<>`\n]*))?$/;

/**
 * La commande des tests liés aux fichiers modifiés (L590) : `orchestrate.testRelated` s'il est déclaré ; sinon, dérivée d'une `orchestrate.test` en chaîne simple `[npx ]vitest run[ options]`
 * (`[npx ]vitest related --run[ options] {files}`) ; null pour toute autre forme (parties, composée, `npm test`…) : la porte joue alors la suite complète. `{files}` reste à remplacer (`withFiles`).
 */
export function relatedCommand(test: GateTest | undefined, related: string | undefined): string | null {
  if (related) return related;
  if (test === undefined || isParts(test) || isComposedGate(test)) return null;
  const m = VITEST_RUN.exec(test);
  return m ? `${m[1] ?? ''}vitest related --run${m[2] ? ` ${m[2]}` : ''} {files}` : null;
}

/** La commande liée avec ses fichiers : chacun protégé pour le shell, séparés par des espaces. */
export const withFiles = (template: string, files: string[]): string => template.replaceAll('{files}', () => files.map(shellArg).join(' '));

/** Le libellé d'une porte (R9 b) : la chaîne telle quelle ; les parties « dir : run » jointes par « ; ». Sert aux messages, aux briefs, au CheckRun et à la clé de cache de la ligne de base. */
export const gateLabel = (t: GateTest): string => (isParts(t) ? t.map((p) => `${p.dir} : ${p.run}`).join(' ; ') : t);

/** La porte a de quoi rejouer un rouge seul : `testReplay` pour une chaîne, au moins une partie avec `replay` pour une liste. */
export const gateReplayable = (t: GateTest | undefined, replay: string | undefined): boolean => (isParts(t) ? t.some((p) => !!p.replay) : !!replay);

/** La commande d'une partie jouée depuis la racine du lieu (worktree local ou de l'hôte) : un dossier introuvable fait sortir le shell en échec en le nommant (« can't cd to dir »), sans test nommé. */
export const partCommand = (p: GatePart, command = p.run): string => `cd ${shellArg(p.dir)} && ${command}`;

/** Joue la porte : la chaîne en un bloc ; les parties toutes, chacune dans son dossier (R8 : une partie rouge ne coupe pas les suivantes), code de la première non nulle, sorties fusionnées sous un en-tête « [dir] ». */
export async function runGate(run: Runner, test: GateTest): Promise<GateRan> {
  if (!isParts(test)) return run(test);
  const parts: PartRan[] = [];
  for (const part of test) {
    const r = await run(partCommand(part));
    parts.push({ part, code: r.code, output: r.output });
  }
  return { code: parts.find((p) => p.code !== 0)?.code ?? 0, output: parts.map((p) => `[${p.part.dir}]\n${p.output}`).join('\n'), parts };
}

/**
 * La porte a échoué pour autre chose qu'un test nommé : forme chaîne, `hasUnnamedFailure` (L354) ; parties, une partie rouge qui ne nomme aucun test (erreur de compilation, « can't cd to », lanceur
 * planté) ou dont la sortie porte un échec sans nom (seuil de couverture, fichier qui ne se charge pas). Rien n'est alors rejoué ni excusé : la porte reste rouge, quoi que le rejeu des autres parties dise (revue du 01-11, bloquant : jamais de faux vert).
 */
export function gateUnnamed(ran: GateRan): boolean {
  if (!ran.parts) return hasUnnamedFailure(ran.output);
  return ran.parts.some((p) => p.code !== 0 && (hasUnnamedFailure(p.output) || failedTests(p.output).length === 0));
}

/** Les rouges nommés de la porte du LOT, candidats au rejeu seul : vide dès que la porte a un échec sans test nommé (`gateUnnamed`), en chaîne comme en parties — rien n'excuse alors le lot. */
export function redCandidates(ran: GateRan): string[] {
  return gateUnnamed(ran) ? [] : failedTests(ran.output);
}

/**
 * Les rouges nommés de la LIGNE DE BASE, candidats au rejeu seul : là, rejouer retire des excuses (un rouge de charge du départ ne doit pas excuser une vraie régression du lot), donc chaque partie est jugée pour elle-même :
 * une partie rouge sans test nommé au départ ne retient que ses propres rouges (aucun), les noms des autres parties sont rejoués par leur partie (`perPart`). Forme chaîne : comme avant (tout ou rien).
 */
export function baselineCandidates(ran: GateRan): string[] {
  return ran.parts ? failedTests(ran.output) : redCandidates(ran);
}

/** Par partie rouge, les noms de `names` qu'elle a imprimés et le verdict de `judge` sur eux seuls ; null (rien de prouvable) pour une partie sans `replay` ou à échec sans nom. */
async function perPart<T>(parts: PartRan[], names: string[], judge: (p: PartRan, own: string[]) => Promise<T>): Promise<{ own: string[]; v: T | null }[]> {
  const out: { own: string[]; v: T | null }[] = [];
  for (const p of parts) {
    if (p.code === 0) continue;
    const printed = new Set(failedTests(p.output));
    const own = names.filter((n) => printed.has(n));
    if (own.length) out.push({ own, v: p.part.replay && !hasUnnamedFailure(p.output) ? await judge(p, own) : null });
  }
  return out;
}

/** Un nom est excusé seulement si CHAQUE partie qui l'a imprimé rouge l'excuse (règle du lead du 01-11 : jamais de faux vert) ; un nom qu'aucune partie rouge n'a imprimé ne l'est pas. */
const everyPart = <T>(judged: { own: string[]; v: T | null }[], names: string[], ok: (v: T, n: string) => boolean): string[] =>
  [...new Set(names)].filter((n) => {
    const mine = judged.filter((j) => j.own.includes(n));
    return mine.length > 0 && mine.every((j) => j.v !== null && ok(j.v, n));
  });

type Replayed = { red: string[]; unstable: string[]; tight: TightTest[] };

/**
 * Rejeu seul des rouges `names` (L354, L510) : forme chaîne, `replayRed` tel quel ; parties, chaque partie rouge rejoue dans son dossier, par son `replay`, les seuls noms qu'elle a imprimés (R4),
 * et un nom imprimé par plusieurs parties n'est instable que si toutes le voient vert (R5) ; le délai trop juste d'un instable est celui lu dans l'une d'elles.
 */
export async function replayGate(run: Runner, replay: string | undefined, names: string[], ran: GateRan): Promise<Replayed> {
  if (!ran.parts) return replayRed(run, replay!, names, ran.output);
  const judged = await perPart(ran.parts, names, (p, own) => replayRed((c) => run(partCommand(p.part, c)), p.part.replay!, own, p.output));
  const unstable = everyPart(judged, names, (v, n) => v.unstable.includes(n));
  const tight = unstable.flatMap((n) => judged.map((j) => j.v?.tight.find((k) => k.test === n)).filter((k): k is TightTest => !!k).slice(0, 1));
  return { red: [...new Set(names)].filter((n) => !unstable.includes(n)), unstable, tight };
}

/**
 * Rouges seuls au sha de départ (L510, R6) : forme chaîne, `redAlone` tel quel ; parties, un nom n'est « déjà rouge » que si chaque partie qui l'a imprimé rouge dans le lot le nomme encore en échec à ses rejeux au départ.
 * `root` : le worktree du lot où la porte a tourné (L514) ; en parties, un fichier node --test de ce worktree est rejoué relatif au dossier de la partie, même hors de ce dossier (evatosorus : `frontend/` rejoue `../scripts/x.test.mjs`).
 */
export async function redAloneGate(run: Runner, replay: string | undefined, names: string[], ran: GateRan, root?: string): Promise<string[]> {
  if (!ran.parts) return redAlone(run, replay!, names, ran.output, root === undefined ? undefined : { root });
  const judged = await perPart(ran.parts, names, (p, own) => redAlone((c) => run(partCommand(p.part, c)), p.part.replay!, own, p.output, root === undefined ? undefined : { root, dir: p.part.dir }));
  return everyPart(judged, names, (v, n) => v.includes(n));
}
