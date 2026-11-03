// Les commandes qui écrivent le plan, un lot à la fois (L488, sorti de cli.ts).
import { relative, resolve } from 'node:path';
import { refuseRedAcceptation } from '../raf-close-checks.js';
import { statusCommand } from '../raf-status.js';
import { PLAN_LEGACY } from '../config.js';
import { audit, isNonConformingVerdict, lotWork, planCommits, unreviewedWork } from '../audit.js';
import { short } from '../check.js';
import { isDay } from '../dates.js';
import { markClosedLot } from '../deliver-close.js';
import { PLAN_ACTIONS } from '../plan-commit.js';
import { printUncommittedPlan } from '../plan-uncommitted.js';
import { resolveCommit } from '../git.js';
import { loadEntries } from '../news.js';
import { addLot } from '../cli-add.js';
import { type Lot, RafError, type Screen, SCREENS, type Status } from '../plan.js';
import { warnIntegrating, warnWaveWorking, waveHolding } from '../repo-busy.js';
import { type Ctx, knownLot, touchedLot } from './context.js';

/** raf add "titre" : ajoute un lot ou une sous-tâche. */
export function cmdAdd(c: Ctx): number | Promise<number> {
  const { rest, values, io, today, root, loadPlan, refuseLongTitle, need } = c;
  need(1, 'add "titre"');
  const plan = loadPlan();
  const id = addLot(plan, values, rest.join(' '), today, refuseLongTitle);
  plan.save();
  io.out(id);
  warnIntegrating(root, io.err);
  warnWaveWorking(root, io.env, io.err);
  return 0;
}

/** raf start|done|drop <id> : pose le statut du lot, sous les refus de la porte de revue, de l'acceptation et du titre public. */
export function cmdSetStatus(c: Ctx): number | Promise<number> {
  const { rest, values, io, today, root, configPath, planConfig, loadPlan, newsDir, refuseLongTitle, need, command } = c;
  need(1, `${command} <id>`);
  const plan = loadPlan();
  const status: Status = command === 'start' ? 'doing' : command === 'done' ? 'done' : 'dropped';
  // Le titre public part au site : un titre au-delà de la limite déclarée y ferait échouer le build.
  if (status === 'done' && !rest[0].includes('/')) {
    const lot = plan.lots().find((l) => l.id === rest[0]);
    // Sans public: d'un lot visible, le site reprend le titre de sa Nouveauté la plus récente.
    const pub = lot?.public ?? (lot?.visible ? loadEntries(newsDir).find((e) => e.lots.includes(lot.id))?.title : undefined);
    if (pub) refuseLongTitle(pub, lot?.public ? '' : ' — titre de la Nouveauté reprise par le site : corriger l\'entrée ou poser raf public');
  }
  // Le plan ne lit pas git : lui dire combien de commits du lot sa revue ne couvre pas quand elle est exigée.
  if (status === 'done' && !rest[0].includes('/')) refuseRedAcceptation(root, configPath, rest[0], !!values.force, io.err);
  const unreviewed = status === 'done' && plan.reviewSince && !plan.readonly && !values.force ? unreviewedWork(plan, root, rest[0]) : 0;
  const verdict = status === 'done' && !rest[0].includes('/') ? plan.lots().find((l) => l.id === rest[0])?.review?.verdict : undefined;
  const nonConforming = verdict !== undefined && isNonConformingVerdict(verdict);
  plan.setStatus(rest[0], status, today, { force: values.force, unreviewed, nonConforming });
  const delivery = status === 'done' ? markClosedLot(plan, root, configPath, rest[0], io.err) : null;
  if (command === 'drop' && values.reason) plan.note(rest[0], `abandonné : ${values.reason}`, today);
  plan.save();
  io.out(`${rest[0]} → ${status}`);
  if (delivery) io.out(delivery);
  if (status === 'done') {
    warnIntegrating(root, io.err);
    warnWaveWorking(root, io.env, io.err);
  }
  touchedLot(plan, rest[0], values.verbose, io);
  if (status === 'done' && !rest[0].includes('/')) {
    const lot = plan.lot(rest[0]);
    if (lot.visible && !loadEntries(newsDir).some((e) => e.lots.includes(lot.id))) {
      io.out(`${lot.id} est visible : écrire l'entrée : cadence news new ${lot.id}`);
    }
    printUncommittedPlan(io.out, plan, root, lot.id, planConfig?.commit);
  }
  return 0;
}

/** raf archive : déplace les lots clos vers .cadence/archive/. */
export function cmdArchive(c: Ctx): number | Promise<number> {
  const { values, io, today, root, planConfig, planPath, loadPlan, newsDir } = c;
  if (values.before !== undefined && !isDay(values.before)) throw new RafError(`--before invalide : ${values.before} (attendu AAAA-MM-JJ)`);
  // L'archive vit à côté du plan : à l'ancien emplacement, elle irait sous docs/ (publié) et raf migrate ne la déplacerait pas — migrer d'abord.
  if (planPath === resolve(root, PLAN_LEGACY)) throw new RafError(`raf archive refusé : le plan est à l'ancien emplacement ${PLAN_LEGACY}, l'archive irait sous docs/ — le déplacer d'abord : raf migrate`);
  const dry = !!values['dry-run'];
  const plan = loadPlan();
  // Un lot clos qui a encore un écart (revue, UX, docs.sync, Nouveauté… ce que `raf check` signale) reste dans le plan, avec l'écart pour raison.
  const issues = audit(plan, root, newsDir, today);
  const blocked = (lot: Lot) => issues.find((i) => plan.refs(i.message).some((r) => r.lot === lot.id))?.message ?? null;
  const { moved, kept } = plan.archive(today, { before: values.before, dryRun: dry, blocked: (lot) => (blocked(lot) ? `écart ouvert — ${blocked(lot)}` : null) });
  const files = [...new Set(moved.map((m) => m.file))];
  for (const f of files) {
    const ids = moved.filter((m) => m.file === f).map((m) => m.lot.id);
    io.out(`${dry ? 'à archiver' : 'archivé'} dans ${relative(io.cwd, f)} : ${ids.join(', ')}`);
  }
  for (const k of kept) io.out(`${k.id} reste dans le plan : ${k.why}`);
  if (moved.length === 0) io.out('rien à archiver');
  else if (!dry) {
    if (plan.republishes) io.err('raf: plan.onWrite republie le fichier du plan sans les lots archivés : le générateur de la copie publiée doit aussi lire .cadence/archive/*.yaml (clé `lots`), sinon l\'historique livré disparaît de la feuille de route publique');
    printUncommittedPlan(io.out, plan, root, moved[0].lot.id, planConfig?.commit, PLAN_ACTIONS.archived(moved.length));
  }
  return 0;
}

/** raf todo <id> : remet en attente un lot démarré sans commit de travail, ou rouvre un lot clos. */
export function cmdTodo(c: Ctx): number | Promise<number> {
  const { rest, values, io, today, root, loadPlan, need } = c;
  need(1, 'todo <id> [--reason texte]');
  const plan = loadPlan();
  plan.putBack(rest[0], today, values.reason ?? '', () => lotWork(plan, root, rest[0]).length);
  plan.save();
  io.out(`${rest[0]} → todo`);
  return 0;
}

/** raf note <id> "texte". */
export function cmdNote(c: Ctx): number | Promise<number> {
  const { rest, values, io, today, root, loadPlan, need } = c;
  need(2, 'note <id> "texte"');
  const plan = loadPlan();
  plan.note(rest[0], rest.slice(1).join(' '), today);
  plan.save();
  warnIntegrating(root, io.err);
  warnWaveWorking(root, io.env, io.err);
  touchedLot(plan, rest[0], values.verbose, io);
  return 0;
}

/** raf did <id> : un lot récurrent a été refait. */
export function cmdDid(c: Ctx): number | Promise<number> {
  const { rest, io, today, loadPlan, need } = c;
  need(1, 'did <id> ["texte"]');
  const plan = loadPlan();
  plan.did(rest[0], today, rest.slice(1).join(' '));
  plan.save();
  io.out(`${rest[0]} refait le ${today}`);
  return 0;
}

/** raf title <id> "titre" : remplace le titre d'un lot. */
export function cmdTitle(c: Ctx): number | Promise<number> {
  const { rest, today, loadPlan, need } = c;
  need(2, 'title <id> "nouveau titre"');
  const plan = loadPlan();
  plan.setTitle(rest[0], rest.slice(1).join(' '), today);
  plan.save();
  return 0;
}

/** raf uses <lot> [<ressource>…] : remplace les ressources partagées du lot. */
export function cmdUses(c: Ctx): number | Promise<number> {
  const { rest, loadPlan, need } = c;
  need(1, 'uses <lot> [<ressource>…]');
  const plan = loadPlan();
  plan.setUses(rest[0], rest.slice(1));
  plan.save();
  return 0;
}

/** raf move <id> --before|--after <id> : réordonne un lot dans le plan. */
export function cmdMove(c: Ctx): number | Promise<number> {
  const { rest, values, io, root, loadPlan } = c;
  // Une seule position : --before ou --after, avec une cible (« after » est aussi le drapeau de « add », « before » celui de « archive »).
  const place = values.before !== undefined && values.after === undefined ? 'before' : values.after !== undefined && values.before === undefined ? 'after' : null;
  if (rest.length !== 1 || !place) throw new RafError('usage : raf move <id> --before <id> | raf move <id> --after <id>');
  const plan = loadPlan();
  plan.move(rest[0], place, values[place]!); // en mémoire : les refus de la commande (plan en lecture seule, parent, archive) passent avant celui de la vague
  // Un lot de la vague s'appuie sur l'ordre du plan qu'il a lu : le réordonner sous ses pieds est refusé tant que la vague tient le dépôt.
  const holding = waveHolding(root, 'move');
  if (holding) throw new RafError(`move : orchestration en cours (vague ${holding.wave}, pid ${holding.pid}) — attendre que les lots de ce dépôt soient finis (le verrou tombe dès que tous sont prêts ou rendus), puis relancer`);
  plan.save();
  touchedLot(plan, rest[0], values.verbose, io);
  return 0;
}

/** raf public <id> "titre public" | --clear. */
export function cmdPublic(c: Ctx): number | Promise<number> {
  const { rest, values, io, loadPlan, refuseLongTitle, need } = c;
  need(values.clear ? 1 : 2, 'public <id> "titre public" | public <id> --clear');
  if (values.clear && rest.length > 1) throw new RafError('--clear n\'attend pas de titre');
  const plan = loadPlan();
  if (!values.clear) refuseLongTitle(rest.slice(1).join(' '));
  plan.setPublic(rest[0], values.clear ? null : rest.slice(1).join(' '));
  plan.save();
  touchedLot(plan, rest[0], values.verbose, io);
  return 0;
}

/** raf screen <id> page|component|journey|none. */
export function cmdScreen(c: Ctx): number | Promise<number> {
  const { rest, loadPlan, need } = c;
  need(2, 'screen <id> page|component|journey|none');
  if (rest.length > 2) throw new RafError('usage : raf screen <id> page|component|journey|none');
  const plan = loadPlan();
  if (rest[1] !== 'none' && !(SCREENS as readonly string[]).includes(rest[1])) throw new RafError(`screen inconnu : ${rest[1]} (${SCREENS.join(', ')}, none)`);
  plan.setScreen(rest[0], rest[1] === 'none' ? null : (rest[1] as Screen));
  plan.save();
  return 0;
}

/** raf estimate <id> <jours>. */
export function cmdEstimate(c: Ctx): number | Promise<number> {
  const { rest, loadPlan } = c;
  if (rest.length !== 2) throw new RafError('usage : raf estimate <id> <jours>');
  const plan = loadPlan();
  if (!/^\d+(\.\d+)?$/.test(rest[1].trim())) throw new RafError(`estimation invalide : ${rest[1]} (un nombre de jours > 0)`);
  plan.setEstimate(rest[0], Number(rest[1]));
  plan.save();
  return 0;
}

/** raf visible <id> on|off. */
export function cmdVisible(c: Ctx): number | Promise<number> {
  const { rest, loadPlan } = c;
  if (rest.length !== 2 || (rest[1] !== 'on' && rest[1] !== 'off')) throw new RafError('usage : raf visible <id> on|off');
  const plan = loadPlan();
  plan.setVisible(rest[0], rest[1] === 'on');
  plan.save();
  return 0;
}

/** raf ignore <sha> | "<sujet exact>" : acquitte un commit sans lot. */
export function cmdIgnore(c: Ctx): number | Promise<number> {
  const { rest, values, io, today, root, loadPlan, need } = c;
  need(1, 'ignore <sha> | "<sujet exact>" [--reason texte]');
  if (rest.length > 1) throw new RafError('un seul commit attendu ; la raison se passe par --reason "texte"');
  const plan = loadPlan();
  const arg = rest[0];
  const commits = planCommits(plan, root);
  // Un sujet exact l'emporte sur un nom de ref homonyme (`other` à la fois sujet et branche).
  const sha = commits.some((c) => c.subject === arg) ? null : resolveCommit(root, arg);
  const found = sha ? commits.find((c) => c.sha === sha) : commits.find((c) => c.subject === arg);
  if (!found) throw new RafError(`aucun commit ne correspond à « ${arg} » (sha ou sujet exact)`);
  // Un sha est exact ; un sujet vaut pour tous les commits qui le portent.
  const bySha = sha !== null;
  plan.acknowledge({ ...(bySha ? { sha: found.sha, subject: found.subject } : { subject: found.subject }), date: today, ...(values.reason ? { reason: values.reason } : {}) });
  plan.save();
  io.out(`${bySha ? short(found) : found.subject} acquitté`);
  return 0;
}

/** raf docs-ok <lot> --reason texte : acquitte l'écart docs.sync d'un lot. */
export function cmdDocsOk(c: Ctx): number | Promise<number> {
  const { rest, values, io, today, loadPlan, need } = c;
  need(1, 'docs-ok <lot> --reason texte');
  if (rest.length > 1) throw new RafError('un seul lot attendu ; la raison se passe par --reason "texte"');
  const plan = loadPlan();
  knownLot(plan, rest[0], 'docs-ok se pose sur un lot, pas sur une sous-tâche');
  plan.setDocsOk(rest[0], values.reason ?? '', today);
  // Un plan en lecture seule n'est pas écrit : l'acquittement est dans .cadence/docs-ok.yaml, à commiter à la place du plan (L386).
  if (plan.readonly) io.out(`${rest[0]} : écart docs.sync acquitté dans .cadence/docs-ok.yaml (le plan n'est pas touché) — commiter ce fichier`);
  else {
    plan.save();
    io.out(`${rest[0]} : écart docs.sync acquitté`);
  }
  return 0;
}

/** raf status : les états détaillés du projet, ou la pose de l'état d'un lot. */
export function cmdStatus(c: Ctx): number {
  const { rest, values, io, today, root, loadPlan } = c;
  return statusCommand(loadPlan(), rest, { back: !!values.back, today, out: io.out, commits: (p, id) => lotWork(p, root, id).length });
}
