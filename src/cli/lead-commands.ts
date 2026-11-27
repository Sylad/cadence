// Les commandes du lead : lead tour|priority|hold|release, config set (L488, sorti de cli.ts).
import { existsSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { type Day } from '../dates.js';
import { gitRoot } from '../git.js';
import { RafError } from '../plan.js';
import { issueLines } from '../issues.js';
import { configSet } from '../config-set.js';
import { movePriority } from '../priority.js';
import { findProjects, isProject, leadTour, leadTourEntries, readDepth, tourCiLines, tourFreeLine, tourLine, tourNoTestLines, tourSettingsLines, tourStaleBranchLines, tourUnpublishedLines, tourWorktreeLines } from '../lead.js';
import { tourMemoryLines } from '../memory-index.js';
import { localOverdueLines } from '../local-task.js';
import { expiredHoldLines, shownCap, slotsLine } from '../orchestrate/command.js';
import { longDuration } from '../orchestrate/guard.js';
import { readLeadCap, writeLeadCap } from '../orchestrate/plafond-lead.js';
import { addHold, cadenceHome, liveRuns, releaseHold, runNamedBy } from '../orchestrate/registry.js';
import { perfHeader } from '../perf.js';
import { tourInspectLines } from '../inspect-read.js';
import { tourQuotaLines } from '../quota-tour.js';
import { tourBancLines } from '../bench-tour.js';
import { readPerf } from '../perf-read.js';
import { suivant, suivantLine, suivantLines } from '../suivant.js';
import { type EarlyCtx, type Io } from './context.js';

/** Les dossiers des projets du tour (la clé `depth:` du dossier, un seul niveau si elle est illisible : le tour a déjà sa ligne d'erreur). */
function tourDirs(parent: string, depth: number | undefined): string[] {
  let levels = depth;
  if (levels === undefined) {
    try {
      levels = readDepth(parent);
    } catch {
      levels = 1;
    }
  }
  const dirs = findProjects(parent, levels);
  return dirs.length === 0 && isProject(parent) ? [parent] : dirs;
}

/** Les racines git des projets du tour. */
const tourRoots = (parent: string, depth: number | undefined): string[] => tourDirs(parent, depth).map((d) => gitRoot(d) ?? d);

/** Les lignes d'issues GitHub du tour (L548), un projet après l'autre, nommé comme sa ligne ; rien sans `gh`. */
function tourIssueLines(parent: string, depth: number | undefined, env: NodeJS.ProcessEnv): string[] {
  return tourDirs(parent, depth).flatMap((d) => issueLines(d, d === parent ? basename(d) : relative(parent, d).split(sep).join('/'), env));
}

/** Durée par défaut (minutes) d'une session du lead inscrite par `lead hold` : de quoi finir un correctif ou une revue, pas de quoi oublier la réservation toute la journée. */
const HOLD_TTL_MINUTES = 60;

/** Longueur maximale de l'étiquette encodée : un nom de fichier tient en 255 octets, `.json.tmp` en prend 9. */
const HOLD_LABEL_MAX = 200;

/** `cadence lead priority <projet> --before|--after <projet> [dossier]` (L449) : range un projet dans la liste `priority:` du cadence.yaml du dossier (celui du tour), sans modèle ni commit. */
function leadPriority(rest: string[], before: string | undefined, after: string | undefined, depth: string | undefined, io: Io): number {
  const usage = 'usage : cadence lead priority <projet> --before|--after <projet> [dossier] [--depth n]';
  if (rest.length < 2 || rest.length > 3 || (before === undefined) === (after === undefined)) throw new RafError(usage);
  const place = before !== undefined ? 'before' : 'after';
  const levels = depth === undefined ? undefined : Number(depth);
  if (levels !== undefined && !(Number.isInteger(levels) && levels >= 1)) throw new RafError(`--depth invalide : ${depth} (un entier ≥ 1)`);
  const parent = resolve(io.cwd, rest[2] ?? '.');
  if (!existsSync(parent)) throw new RafError(`lead priority : dossier introuvable : ${parent}`);
  const target = (before ?? after)!;
  const moved = movePriority(parent, rest[1]!, place, target, levels);
  io.out(moved.changed ? `${rest[1]} placé ${place === 'before' ? 'avant' : 'après'} ${target} dans priority: de ${join(parent, 'cadence.yaml')} (ordre : ${moved.order.join(' > ')}) — le fichier est modifié, à commiter` : `${rest[1]} est déjà ${place === 'before' ? 'avant' : 'après'} ${target} : rien à changer`);
  return 0;
}

/** Un cadence run vivant se compte seul dans les créneaux (L710) : le tenir aussi par `lead hold` le compterait deux fois. */
function refuseLiveRun(label: string): void {
  const run = runNamedBy(label, liveRuns(cadenceHome()));
  if (!run) return;
  const named = run.lot ? `ni ${run.lot} ni ${run.id}` : `pas ${run.id}`;
  throw new RafError(`« ${label} » nomme le cadence run vivant ${run.id}${run.lot ? ` (lot ${run.lot})` : ''} de ${basename(run.repo)} : il se compte déjà dans les créneaux, le tenir aussi le compterait deux fois ; pour une autre session, une étiquette qui ne cite ${named}`);
}

/** `cadence lead hold <étiquette> [--ttl minutes]` / `lead release <étiquette>` (L255) : inscrit, ou rend, une session lancée à la main par le lead, qui compte dans les créneaux libres. */
function leadHold(rest: string[], ttl: string | undefined, io: Io, today: Day): number {
  const [verb, label] = rest;
  const usage = verb === 'hold' ? 'usage : cadence lead hold <étiquette> [--ttl minutes]' : 'usage : cadence lead release <étiquette>';
  if (rest.length !== 2 || !label!.trim()) throw new RafError(usage);
  if (verb === 'release') {
    if (ttl !== undefined) throw new RafError(`--ttl ne va qu'avec lead hold (${usage})`);
    io.out(releaseHold(cadenceHome(), label!) ? `session « ${label} » rendue` : `aucune session « ${label} » inscrite`);
    // ce que la libération laisse (L416) : les créneaux, les lots prêts qui peuvent les prendre, et un ⚠ tant qu'un créneau reste vide
    const { cap, setting } = shownCap(io.env);
    const { line, free } = slotsLine(cap, io.now(), setting);
    io.out(line);
    const ready = tourFreeLine(leadTour(resolve(io.cwd), today));
    if (ready) io.out(ready);
    if (free > 0) io.out(`⚠ ${free} ${free === 1 ? 'créneau libre' : 'créneaux libres'} sur ${cap} : lancer un lot prêt ou une session, un créneau vide ne sert à rien`);
    return 0;
  }
  // le nom de fichier encode l'étiquette (6 octets par lettre accentuée) : au-delà, le système de fichiers refuse (ENAMETOOLONG)
  if (encodeURIComponent(label!).length > HOLD_LABEL_MAX) throw new RafError(`étiquette trop longue (${usage})`);
  const minutes = ttl === undefined ? HOLD_TTL_MINUTES : Number(ttl);
  if (!(Number.isInteger(minutes) && minutes >= 1)) throw new RafError(`--ttl invalide : ${ttl} (un nombre entier de minutes ≥ 1)`);
  refuseLiveRun(label!);
  addHold(cadenceHome(), label!, minutes, io.now());
  io.out(`session « ${label} » inscrite pour ${minutes} min : elle compte dans les créneaux libres (cadence lead release « ${label} » à sa fin)`);
  return 0;
}

/**
 * `cadence lead plafond [<n>|aucun]` (L802, D-30) : le plafond que le lead s'applique sous le réglage CADENCE_MAX_SESSIONS (rythme du quota…).
 * Les créneaux de la bande, de `orchestrate --status` et de `lead tour` se comptent alors sur lui, et un lancement de vague le respecte ;
 * il ne relève jamais le réglage. Sans argument : le plafond appliqué.
 */
function leadPlafond(rest: string[], io: Io): number {
  const usage = 'usage : cadence lead plafond [<n> | aucun]';
  if (rest.length > 2) throw new RafError(usage);
  const home = cadenceHome();
  const arg = rest[1];
  if (arg === 'aucun') writeLeadCap(home, null, io.now());
  else if (arg !== undefined) {
    const n = Number(arg);
    if (!(Number.isInteger(n) && n >= 1)) throw new RafError(`plafond invalide : ${arg} (un entier ≥ 1, ou « aucun » pour le retirer ; ${usage})`);
    writeLeadCap(home, n, io.now());
  }
  const lead = readLeadCap(home);
  const { cap, setting } = shownCap(io.env);
  // depuis quand (revue L802) : un plafond posé pour le rythme du quota survit à la remise à zéro, son âge le rappelle ; `since` illisible : rien
  const since = lead ? Date.parse(lead.since) : NaN;
  const age = Number.isFinite(since) ? `, posé depuis ${longDuration(io.now().getTime() - since)} (${lead!.since.slice(0, 16).replace('T', ' ')} UTC)` : '';
  if (!lead) io.out(`plafond du lead : aucun · créneaux sur ${setting} (réglage CADENCE_MAX_SESSIONS)`);
  else if (lead.cap >= setting) io.out(`plafond du lead : ${lead.cap}, sans effet (réglage ${setting}, le lead ne le relève pas)${age} · créneaux sur ${cap}`);
  else io.out(`plafond du lead : ${lead.cap} (réglage ${setting})${age} · créneaux, lancements de vague, bande et lead tour sur ${cap} ; le retirer : cadence lead plafond aucun`);
  return 0;
}

/** Poser une clé dans le cadence.yaml de chaque projet du dossier (L342) : ne lit ni le plan ni le cadence.yaml du dossier courant. */
export function cmdConfig(c: EarlyCtx): number {
  const { rest, values, io, today } = c;
  if (rest[0] !== 'set' || rest.length !== 3) throw new RafError('usage : cadence config set <clé> <valeur> --all [--dry-run] [--depth n]');
  if (!values.all) throw new RafError('config set demande --all : la commande s\'applique aux projets du dossier courant (lancer la commande dans le projet visé pour un seul)');
  if (values.depth !== undefined && !(Number.isInteger(Number(values.depth)) && Number(values.depth) >= 1)) throw new RafError(`--depth invalide : ${values.depth} (un entier ≥ 1)`);
  const parent = resolve(io.cwd);
  const result = configSet(parent, rest[1], rest[2], { dryRun: values['dry-run'], depth: values.depth === undefined ? readDepth(parent) : Number(values.depth) }, today);
  for (const l of result.lines) io.out(l);
  return result.code;
}

/** cadence lead tour|priority|hold|release. Le tour parcourt les sous-dossiers (ou, sans sous-projet, prend le dossier lui-même s'il est un projet) : il ne lit pas le plan du dossier courant. */
export function cmdLead(c: EarlyCtx): number {
  const { rest, values, io, today } = c;
  if (rest[0] === 'hold' || rest[0] === 'release') return leadHold(rest, values.ttl, io, today);
  if (rest[0] === 'plafond') return leadPlafond(rest, io);
  if (rest[0] === 'priority') return leadPriority(rest, values.before, values.after, values.depth, io);
  if (values.ttl !== undefined) throw new RafError('--ttl ne va qu\'avec lead hold');
  if (rest[0] !== 'tour' || rest.length > 2) throw new RafError('usage : cadence lead tour [dossier] [--idle 3] [--depth n] [--json] | lead priority <projet> --before|--after <projet> [dossier] | lead hold <étiquette> [--ttl minutes] | lead release <étiquette> | lead plafond [<n> | aucun]');
  const idle = values.idle === undefined ? undefined : Number(values.idle);
  if (idle !== undefined && !(Number.isInteger(idle) && idle >= 0)) throw new RafError(`--idle invalide : ${values.idle}`);
  const depth = values.depth === undefined ? undefined : Number(values.depth);
  if (depth !== undefined && !(Number.isInteger(depth) && depth >= 1)) throw new RafError(`--depth invalide : ${values.depth} (un entier ≥ 1)`);
  const parent = resolve(io.cwd, rest[1] ?? '.');
  if (!existsSync(parent)) throw new RafError(`lead tour : dossier introuvable : ${parent}`);
  const entries = leadTourEntries(parent, today, idle, depth);
  const rows = entries.map((e) => e.row);
  if (values.json) io.out(JSON.stringify(rows, null, 2));
  else if (rows.length === 0) io.out(`aucun projet sous ${parent} (.cadence/raf.yaml, docs/plan/raf.yaml ou cadence.yaml avec plan:)`);
  else {
    // L'en-tête perf (L227) : un ⚠ par ligne avant les projets ; un dossier que perf ne lit pas n'en donne pas, et ses avertissements ne sont pas repris.
    try {
      for (const l of perfHeader(readPerf(parent, today, undefined, () => {}))) io.out(l);
    } catch {
      // pas de .cadence/runs, grille de prix mal formée, journaux ou plans illisibles : le tour ne change pas
    }
    for (const r of rows) io.out(tourLine(r));
    // les lots en service que la publication n'a pas encore pris (L571) : le lead joue cadence release, le tour n'en publie aucun
    // … puis les worktrees de lot que des vagues ont conservés : aucun n'est oublié en silence (L279, R19)
    // … puis l'index MEMORY.md du dossier, s'il pèse trop (L442) : le lead propose le regroupement, rien n'est écrit
    // … puis l'inspection de la dernière vague (L627) : sa première récidive et le lot qui la supprime, une ligne
    for (const l of [...tourUnpublishedLines(rows), ...tourWorktreeLines(rows, io.now().getTime()), ...tourStaleBranchLines(rows, io.now().getTime()), ...tourMemoryLines(io.env, parent), ...tourInspectLines(parent)]) io.out(l);
    // un projet sans orchestrate.test : la vague ne lancera pas la suite (L327) ; puis ce que la CI joue et que la porte ne joue pas (L499)
    // … puis les issues GitHub ouvertes qu'aucun lot ne cite, ou dont le lot est publié (L548) : le lead les ferme, le tour n'en ferme aucune
    for (const l of [...tourNoTestLines(rows), ...tourCiLines(rows), ...tourIssueLines(parent, depth, io.env)]) io.out(l);
    // les créneaux libres viennent du registre, le lead les lit au lieu de les calculer (L141)
    // toujours imprimés, même sans vague ni session du lead (L416) : un créneau vide se lit, il ne se déduit pas d'une ligne absente
    const { cap, setting } = shownCap(io.env);
    io.out(slotsLine(cap, io.now(), setting).line);
    // en face des créneaux libres, les lots prêts dont aucune ressource n'est prise (L252)
    const free = tourFreeLine(rows);
    if (free) io.out(free);
    // une session du lead dont le TTL est échu (L278) : rien ne l'arrête, le tour la signale (hors --json, comme les créneaux)
    // … et une tâche locale (L519) au-delà de son délai : le dépôt reste verrouillé, le tour le dit au lieu de le libérer en silence
    // … puis la jauge hebdo publiée par la bande cadence-hud (⚠ au-delà de 80 %) et les runs de cadence run en quota avec leur reprise (L700, D-15)
    const roots = tourRoots(parent, depth);
    // … puis l'alerte de la garde de publication (L730, D-22) : un banc complet du samedi rouge, ou manqué, fait revenir la garde au banc complet
    for (const l of [...expiredHoldLines(io.now()), ...localOverdueLines(roots, io.now()), ...tourQuotaLines(io.env, roots, io.now().getTime()), ...tourBancLines(roots, io.env)]) io.out(l);
    // … puis ce que cadence suivant rendrait (L931) : le même calcul sur les lignes du tour, dépôts tenus sautés, lot en cours sans run ni commit d'abord
    io.out(suivantLine(suivant(parent, today, { cap, env: io.env, now: io.now(), entries })));
    // les réglages lead.chain (L772) puis lead.ux (L197) du cadence.yaml du dossier : le lead les lit ici, au lieu d'ouvrir le fichier
    for (const l of tourSettingsLines(parent)) io.out(l);
  }
  return 0;
}

/**
 * `cadence suivant [dossier] [--depth n] [--json]` (L931, D-44) : le prochain projet:lot à lancer depuis un dossier parent, sans modèle et sans rien lancer.
 * Code 0 quand un lot est rendu, 1 pour « rien » (créneaux pleins, dépôts tenus, aucun lot tirable), 2 pour un appel mal formé.
 */
export function cmdSuivant(c: EarlyCtx): number {
  const { rest, values, io, today } = c;
  const usage = 'usage : cadence suivant [dossier] [--depth n] [--json]';
  if (rest.length > 1) throw new RafError(usage);
  const depth = values.depth === undefined ? undefined : Number(values.depth);
  if (depth !== undefined && !(Number.isInteger(depth) && depth >= 1)) throw new RafError(`--depth invalide : ${values.depth} (un entier ≥ 1)`);
  const parent = resolve(io.cwd, rest[0] ?? '.');
  if (!existsSync(parent)) throw new RafError(`suivant : dossier introuvable : ${parent}`);
  const { cap } = shownCap(io.env);
  const s = suivant(parent, today, { cap, env: io.env, now: io.now(), depth });
  if (values.json) io.out(JSON.stringify(s, null, 2));
  else for (const l of suivantLines(s)) io.out(l);
  return s.next ? 0 : 1;
}
