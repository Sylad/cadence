import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isNode, isScalar, parse, parseDocument, type Document } from 'yaml';
import { defaultPlan, readDocsConfig, readHookConfig, readMigrateConfig, readNewsConfig, readOrchestrateConfig, readPerfConfig, readPlanConfig, readReferencesConfig, readSessionConfig } from './config.js';
import type { Day } from './dates.js';
import { parseDeliverConfig } from './deliver.js';
import { commitPaths, dirtyPaths, gitRoot, restorePaths } from './git.js';
import { findProjects, isProject, readDepth, readLeadContextThreshold, readLeadUx } from './lead.js';
import { readPriority } from './orchestrate/continue.js';
import { Plan, RafError, type PlanSettings } from './plan.js';

const KEY = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** Un argument de shell entre apostrophes. */
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Estimation du lot de config : une ligne de configuration, pas une journée. */
const ESTIMATE = 0.05;

interface ConfigSetResult {
  lines: string[];
  /** 0 : tous les projets sont passés ou sautés ; 1 : arrêt sur un projet. */
  code: number;
}

/** Relit un cadence.yaml avec chacun des chargeurs de config de cadence : la première erreur sort (RafError). */
export function validateConfig(file: string, root: string): void {
  readPlanConfig(file, root);
  readNewsConfig(file);
  readHookConfig(file);
  readPerfConfig(file);
  readSessionConfig(file);
  readOrchestrateConfig(file);
  readDocsConfig(file);
  readReferencesConfig(file);
  readMigrateConfig(file);
  readLeadUx(dirname(file));
  readLeadContextThreshold(dirname(file));
  readDepth(dirname(file));
  readPriority(dirname(file));
  const text = readFileSync(file, 'utf8');
  if ((parse(text) as { deliver?: unknown } | null)?.deliver != null) parseDeliverConfig(text, file);
}

/** Les chargeurs lisent un chemin : le texte est posé dans un dossier jetable, le cadence.yaml du projet ne change pas avant d'avoir été relu. */
function inTemp<T>(text: string, use: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-config-'));
  try {
    const file = join(dir, 'cadence.yaml');
    writeFileSync(file, text);
    try {
      return use(file);
    } catch (e) {
      throw new RafError((e instanceof Error ? e.message : String(e)).split('\n')[0]!.replaceAll(file, 'cadence.yaml'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Le message de la première erreur des chargeurs de config sur ce texte, null quand il se relit. */
function readsBack(text: string, root: string): string | null {
  try {
    inTemp(text, (file) => validateConfig(file, root));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Le texte de cadence.yaml avec `key` posée à `value` (le reste du fichier est gardé tel quel : seules les lignes de la clé changent) ; null quand la clé a déjà cette valeur. */
export function setKey(text: string, key: string, value: Document): string | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new RafError(doc.errors[0]!.message.split('\n')[0]!);
  const baseline = doc.toString({ lineWidth: 0 });
  const path = key.split('.');
  const old = doc.getIn(path, true);
  const next = value.clone().contents; // une copie par projet : le commentaire de l'ancienne valeur ne passe pas au projet suivant
  if (JSON.stringify(doc.getIn(path)) === JSON.stringify(value.toJS())) return null;
  if (isScalar(old) && isScalar(next)) old.value = next.value; // la même case : son commentaire de fin de ligne reste
  else {
    if (isNode(old) && isNode(next)) next.comment = old.comment;
    doc.setIn(path, next);
  }
  const full = doc.toString({ lineWidth: 0 });
  const kept = onlyChangedLines(text, baseline, full);
  return readsAs(kept, full) ? kept : full; // un report mal aligné change le sens du fichier : l'écriture entière de yaml
}

/** Les deux textes sont le même document YAML ; un texte qui ne se lit pas (clés en double d'un report mal aligné) n'est pas le même. */
function readsAs(text: string, expected: string): boolean {
  try {
    return JSON.stringify(parse(text)) === JSON.stringify(parse(expected));
  } catch {
    return false;
  }
}

/**
 * La réécriture de yaml normalise tout le fichier (`[a, b]` devient `[ a, b ]`, les espaces avant un commentaire de fin de ligne) :
 * seules les lignes que la pose de la clé a changées (`baseline` → `changed`, deux écritures de yaml) sont reportées dans le texte d'origine.
 * Quand yaml a aussi changé le nombre de lignes du fichier non modifié, le report n'est pas sûr : l'écriture entière de yaml est rendue (`setKey` la rend aussi quand le report ne relit pas le même document).
 */
function onlyChangedLines(original: string, baseline: string, changed: string): string {
  const o = original.split('\n');
  const b = baseline.split('\n');
  const c = changed.split('\n');
  if (o.length !== b.length) return changed;
  let head = 0;
  while (head < b.length && head < c.length && b[head] === c[head]) head++;
  let tail = 0;
  while (tail < b.length - head && tail < c.length - head && b[b.length - 1 - tail] === c[c.length - 1 - tail]) tail++;
  // Les lignes reportées doivent être celles que yaml a écrites au même endroit : un commentaire que yaml a déplacé d'une ligne (compensé par une liste regroupée) ne se reporte pas.
  const sameComments = (from: number, n: number, ofB: number) => Array.from({ length: n }, (_, k) => commentOf(o[from + k]!) === commentOf(b[ofB + k]!)).every(Boolean);
  if (!sameComments(0, head, 0) || !sameComments(o.length - tail, tail, b.length - tail)) return changed;
  return [...o.slice(0, head), ...c.slice(head, c.length - tail), ...o.slice(o.length - tail)].join('\n');
}

/** Le commentaire d'une ligne (à partir du premier `#` en début de ligne ou après un blanc), '' sans commentaire ; une erreur sur un `#` de chaîne ne coûte que l'écriture entière. */
const commentOf = (line: string) => /(^|\s)#.*$/.exec(line)?.[0].trim() ?? '';

/**
 * `cadence config set <clé> <valeur> --all` (L342) : pose la même clé dans le cadence.yaml de chaque projet de `parent` (ceux que `lead tour` connaît),
 * crée dans chacun un lot de config qui la cite (en cours, à fermer par le lead) et commite à chemin explicite le cadence.yaml et le plan, sans pousser.
 * Un projet que la commande ne peut pas traiter sans risque est sauté et dit pourquoi ; une config qui ne se relit pas arrête le passage.
 */
export function configSet(parent: string, key: string, valueText: string, opts: { dryRun?: boolean; depth: number }, today: Day): ConfigSetResult {
  if (!KEY.test(key)) throw new RafError(`clé invalide : « ${key} » (segments de lettres, chiffres, - ou _ séparés par des points : orchestrate.escalation)`);
  if (valueText.trim() === '') throw new RafError('valeur vide : cadence config set <clé> <valeur> --all');
  const value = parseDocument(valueText);
  if (value.errors.length > 0 || value.contents == null) throw new RafError(`valeur illisible en YAML : ${valueText} — ${value.errors[0]?.message.split('\n')[0] ?? 'vide'}`);
  const shown = valueText.trim().replace(/\s+/g, ' ');

  let projects = findProjects(parent, opts.depth);
  if (projects.length === 0 && isProject(parent)) projects = [parent]; // comme lead tour : sans sous-projet, le dossier lui-même s'il en est un
  if (projects.length === 0) return { lines: [`aucun projet sous ${parent} (.cadence/raf.yaml, docs/plan/raf.yaml ou cadence.yaml avec plan:)`], code: 0 };

  const lines: string[] = [];
  let done = 0;
  let skipped = 0;
  let stopped = false;
  for (const [i, dir] of projects.entries()) {
    const name = relative(parent, dir).split('\\').join('/') || basename(dir);
    const skip = (why: string) => {
      skipped++;
      lines.push(`– ${name} · sauté : ${why}`);
    };
    const stop = (why: string) => {
      stopped = true;
      lines.push(`✗ ${name} · arrêt : ${why}`);
      const rest = projects.slice(i + 1).map((p) => relative(parent, p).split('\\').join('/'));
      if (rest.length) lines.push(`non traités : ${rest.join(', ')}`);
    };

    const top = gitRoot(dir);
    if (!top || realpathSync(top) !== realpathSync(dir)) {
      skip(top ? `pas de dépôt git propre au projet (dépôt parent : ${top})` : 'pas un dépôt git');
      continue;
    }
    const configFile = join(dir, 'cadence.yaml');
    const before = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null;
    if (before !== null) {
      const unreadable = readsBack(before, dir);
      if (unreadable) {
        stop(`la config ne se relit pas, avant toute modification : ${unreadable}`);
        break;
      }
    }
    let text: string | null;
    try {
      text = setKey(before ?? '', key, value);
    } catch (e) {
      skip(`la clé ne se pose pas dans ce cadence.yaml (${(e as Error).message.split('\n')[0]})`);
      continue;
    }
    if (text === null) {
      skip(`${key} a déjà cette valeur`);
      continue;
    }
    const failure = readsBack(text, dir);
    if (failure) {
      stop(`la config modifiée ne se relit pas (${failure}) — rien n'est écrit ici`);
      break;
    }
    // Le plan : lu avec la config modifiée (une clé plan: posée peut le déplacer) ; un plan tenu par un autre outil ne se modifie pas d'ici.
    const found = planOf(text, dir);
    if (found.readonly && !found.add) {
      skip(`plan en lecture seule (tenu par un autre outil) sans commande de création : nommer plan.add dans son cadence.yaml, ou créer le lot de config avec l'outil du projet puis poser ${key}`);
      continue;
    }
    const planPath = found.path ?? defaultPlan(dir).path;
    const planRel = relative(dir, planPath).split('\\').join('/');
    if (!existsSync(planPath)) {
      skip(`pas de plan à ${planRel}`);
      continue;
    }
    const produced = found.settings.onWrite?.files ?? [];
    const dirty = dirtyPaths(dir, ['cadence.yaml', planRel, ...produced]);
    if (dirty.length) {
      skip(`${dirty.join(', ')} non commité : le commit à chemin explicite l'emporterait`);
      continue;
    }
    if (opts.dryRun) {
      lines.push(`+ ${name} · serait fait : ${key} = ${shown}, lot de config créé et démarré dans ${planRel}, commit de cadence.yaml et ${planRel}`);
      done++;
      continue;
    }

    const planBefore = readFileSync(planPath, 'utf8');
    // Ce que plan.onWrite produit est propre ici (vérifié plus haut) : le défaire, c'est le remettre à HEAD.
    const restore = () => {
      restorePaths(dir, produced);
      if (before === null) {
        if (existsSync(configFile)) unlinkSync(configFile);
      } else writeFileSync(configFile, before);
      writeFileSync(planPath, planBefore);
    };
    try {
      writeFileSync(configFile, text);
      const title = `config cadence.yaml : ${key} = ${shown}`;
      let id: string;
      if (found.readonly && found.add) {
        // La commande du plan crée le lot (et l'ouvre, si son outil le veut) : l'identifiant est le premier mot de sa sortie qui ressemble à un id de lot.
        const out = execSync(found.add.replaceAll('{title}', shellQuote(title)), { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        id = /\b[A-Za-z]+-?\d+(?:\.\d+)?\b/.exec(out)?.[0] ?? '';
      } else {
        const plan = Plan.load(planPath, { ...found.settings, config: configFile });
        id = plan.add(title, today, { estimate: ESTIMATE });
        plan.setStatus(id, 'doing', today);
        plan.save();
      }
      const sha = commitPaths(dir, ['cadence.yaml', planRel, ...dirtyPaths(dir, produced)], `chore${id ? `(${id})` : ''}: cadence.yaml — ${key} = ${shown}`);
      done++;
      lines.push(`✓ ${name} · ${id || 'lot de config'} · ${key} = ${shown} · commit ${sha}`);
    } catch (e) {
      restore();
      stop(`lot ou commit impossible, fichiers remis en l'état (${(e as Error).message.split('\n')[0]})`);
      break;
    }
  }
  lines.push(`${done} fait${done > 1 ? 's' : ''}${opts.dryRun ? ' (simulation, rien écrit)' : ''}, ${skipped} sauté${skipped > 1 ? 's' : ''}${stopped ? ', arrêt sur un projet' : ''}`);
  return { lines, code: stopped ? 1 : 0 };
}

/** Où est le plan et est-il en lecture seule, d'après le texte de config modifié. */
function planOf(text: string, root: string): { readonly: boolean; path?: string; add?: string; settings: PlanSettings } {
  const c = inTemp(text, (file) => readPlanConfig(file, root));
  return { readonly: !!c?.settings.format, ...(c?.path ? { path: resolve(root, c.path) } : {}), ...(c?.add ? { add: c.add } : {}), settings: c?.settings ?? {} };
}
