// raf import (L472, M10) : un plan tenu dans un autre format (cadence.yaml : plan.lots, fields, statuses, estimates) vers le natif, et le chemin inverse.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Document, parseDocument } from 'yaml';
import { PLAN_DEFAULT } from '../config.js';
import { initialContent } from '../plan-init.js';
import { foreignEntries, nativeEntries, readingDiff, roundTripDiff, type Renames } from '../plan-import.js';
import { Plan, RafError, type PlanFormat } from '../plan.js';
import type { Ctx } from './context.js';

type Entry = Record<string, unknown>;

const USAGE = 'usage : raf import --from-config [--out plan-natif.yaml] [--verify] [--rename ancien=nouveau]… [--force] [--dry-run] | raf import --to-config [--from plan-natif.yaml] [--out plan.yaml] [--rename ancien=nouveau]… [--force] [--dry-run]';
/** Les écarts listés avant « … » : un plan entier mal mappé en dirait des milliers. */
const SHOWN = 20;
/** Le retour ne réécrit que le plan : le journal d'événements de l'autre outil n'a pas de format déclaré (plan.fields n'en décrit aucun), il reste tel qu'il est. */
const JOURNAL_NOTE = 'journal.ndjson inchangé : format déclaratif à venir, L582';

/** `--rename ancien=nouveau` (répétable) : un nom de clé du fichier d'origine pris en natif sous un autre nom. */
function parseRenames(list: string[] | undefined): Renames {
  const renames: Renames = {};
  for (const item of list ?? []) {
    const [from, to, ...more] = item.split('=');
    if (!from || !to || more.length > 0 || from === to) throw new RafError(`--rename invalide : ${item} (attendu ancien=nouveau, deux noms différents)`);
    if (Object.hasOwn(renames, from)) throw new RafError(`--rename : « ${from} » est renommée deux fois`);
    renames[from] = to;
  }
  if (new Set(Object.values(renames)).size !== Object.keys(renames).length) throw new RafError('--rename : deux clés prennent le même nom');
  return renames;
}

const shown = (diffs: string[]): string => [...diffs.slice(0, SHOWN), ...(diffs.length > SHOWN ? [`… et ${diffs.length - SHOWN} autre(s)`] : [])].join('\n');

/** raf import --from-config | --to-config. */
export function cmdImport(c: Ctx): number {
  const { values, rest } = c;
  const [from, to] = [!!values['from-config'], !!values['to-config']];
  if (rest.length > 0 || from === to) throw new RafError(USAGE);
  if (to && values.verify) throw new RafError('--verify ne va qu\'avec --from-config (il relit le plan natif écrit)');
  if (from && values.from !== undefined) throw new RafError('--from ne va qu\'avec --to-config');
  const format = c.planConfig?.settings.format;
  if (!format) throw new RafError('rien à importer : cadence.yaml ne décrit pas de plan tenu par un autre outil (plan.lots, plan.fields, plan.statuses ou plan.estimates)');
  const renames = parseRenames(values.rename);
  return from ? importFrom(c, format, renames) : importTo(c, format, renames);
}

/** Le chemin d'écriture : refusé s'il est le fichier dont on lit, ou s'il existe déjà sans --force. */
function target(c: Ctx, path: string, readFrom: string, label: string): string {
  if (path === readFrom) throw new RafError(`${path} est le fichier d'origine (${label}) : il n'est jamais réécrit par cet import — choisir un autre --out`);
  if (existsSync(path) && !c.values.force) throw new RafError(`${path} existe déjà — --force pour le remplacer`);
  return path;
}

/** Le plan natif relu depuis son texte, comparé à l'original : lu pareil par raf (raf check n'y verrait rien que l'original n'ait), et rejoué dans l'autre sens. `what` nomme le texte relu dans le refus. */
function verifyText(raw: Entry[], text: string, what: { refusal: string; subject: string }, format: PlanFormat, renames: Renames): void {
  const reread = (parseDocument(text).toJSON() as { lots: Entry[] }).lots;
  const diffs = [...readingDiff(raw, reread, format), ...roundTripDiff(raw, foreignEntries(reread, format, renames), format)];
  if (diffs.length > 0) throw new RafError(`${what.refusal} : le plan natif ${what.subject} ne dit pas la même chose que l'original\n${shown(diffs)}`);
}

function importFrom(c: Ctx, format: PlanFormat, renames: Renames): number {
  const { values, io, root, today, planPath, planConfig } = c;
  const out = target(c, resolve(io.cwd, values.out ?? join(root, PLAN_DEFAULT)), planPath, 'plan du projet');
  const raw = Plan.load(planPath, { ...planConfig?.settings, config: c.configPath }).rawEntries();
  const entries = nativeEntries(raw, format, renames, today);
  const lost = roundTripDiff(raw, foreignEntries(entries, format, renames), format);
  if (lost.length > 0) throw new RafError(`import refusé : l'aller-retour perdrait de l'information\n${shown(lost)}`);
  const doc = parseDocument(initialContent(planConfig?.settings.project ?? basename(root), 'L', planConfig?.settings.since ?? today));
  doc.set('lots', doc.createNode(entries));
  const text = doc.toString({ lineWidth: 0 });
  // Toujours avant d'écrire : un natif que raf relirait autrement (ou avec un problème) n'est jamais écrit, --verify ou pas.
  verifyText(raw, text, { refusal: 'import refusé', subject: 'qu\'on écrirait' }, format, renames);
  const dryRun = !!values['dry-run'];
  if (!dryRun) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    if (values.verify) verifyText(raw, readFileSync(out, 'utf8'), { refusal: 'vérification échouée', subject: `écrit (${out})` }, format, renames);
  }
  io.out(dryRun ? `${entries.length} lots vérifiés, sans perte — rien n'est écrit (--dry-run)` : `${entries.length} lots importés → ${out}${values.verify ? ' — relu et rejoué dans l\'autre sens : sans perte' : ' (--verify relit le fichier écrit et rejoue l\'écriture inverse)'}`);
  if (entries.some((e) => !/^L\d+$/.test(String(e.id)))) io.out('ids libres : déclarer plan.idPattern dans le cadence.yaml du plan natif pour que raf reconnaisse ces identifiants dans les messages de commit');
  return 0;
}

function importTo(c: Ctx, format: PlanFormat, renames: Renames): number {
  const { values, io, root, planPath } = c;
  const from = resolve(io.cwd, values.from ?? join(root, PLAN_DEFAULT));
  const out = target(c, resolve(io.cwd, values.out ?? planPath), from, 'plan natif');
  const native = Plan.load(from, { config: c.configPath });
  if (native.archiveFiles().length > 0) throw new RafError(`${from} a des lots archivés (${native.archiveFiles().length} fichier(s) d'archive) : le retour ne les écrirait pas — les remettre dans le plan d'abord (raf todo)`);
  const entries = foreignEntries(native.rawEntries(), format, renames);
  if (!values['dry-run']) {
    const doc = existsSync(out) ? parseDocument(readFileSync(out, 'utf8')) : new Document({});
    doc.set(format.lots, doc.createNode(entries));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, doc.toString({ lineWidth: 0 }));
  }
  io.out(values['dry-run'] ? `${entries.length} lots à écrire au format d'origine — rien n'est écrit (--dry-run)` : `${entries.length} lots écrits au format d'origine → ${out}`);
  io.out(JOURNAL_NOTE);
  return 0;
}
