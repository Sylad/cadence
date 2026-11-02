// Les commandes de la spec : check|qa de la fiche, spec on|off, green et reseal de l'acceptation (L488, sorti de cli.ts).
import { dirtyPaths } from '../git.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { readOrchestrateConfig, readPlanConfig } from '../config.js';
import { type Day } from '../dates.js';
import { PLAN_ACTIONS, planCommitMessage } from '../plan-commit.js';
import { gitRoot } from '../git.js';
import { Plan, RafError } from '../plan.js';
import { waveHolding } from '../repo-busy.js';
import { cadenceHome, liveWaves, openLotsIn, type OpenWave, openWavesIn } from '../orchestrate/registry.js';
import { resumeCommand } from '../orchestrate/table.js';
import { findAcceptation, modeSpecGreen, parseAcceptation, resealAcceptation, resealForGreen, runAcceptation, setVert } from '../orchestrate/accept.js';
import { checkFiche, deriveQa, readFiche, summary } from '../spec.js';
import { type Ctx, type EarlyCtx, type Io } from './context.js';

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Chemin à coller dans un shell : entre apostrophes dès qu'il contient autre chose que des caractères sûrs. */
const shellPath = (p: string): string => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);

/** Le refus de `spec reseal` devant des vagues non terminées (L238) : chaque vague (vivante ou arrêtée), son dossier de lancement, ses lots, et pour chaque vague arrêtée UNE commande à lancer telle quelle (un `--drop` par lot ouvert du dépôt, y compris ceux en file qui ne sont pas en cours au plan : `--resume` relance toute la vague avec les lots non retirés, et un lot en file reprendrait le verrou, L239). */
function openWavesRefusal(open: OpenWave[], command: 'spec reseal' | 'spec green'): string {
  const lines = open.map((w) => {
    const where = [w.live ? 'vivante' : 'arrêtée', ...(w.live && w.pid !== undefined ? [`pid ${w.pid}`] : []), ...(w.launchDir ? [`lancée depuis ${w.launchDir}`] : [])].join(', ');
    return `  - vague ${w.wave} (${where}) : ${w.lots.length ? [...w.lots.map((l) => `${l.key} (${l.status})`), ...w.others.map((l) => `${l.key} (${l.status}, pas en cours au plan)`)].join(', ') : 'lots illisibles'}`;
  });
  const how = open.map((w) =>
    w.live
      ? `  vague ${w.wave} : orchestration en cours, à attendre (le verrou du dépôt tombe dès que tous ses lots y sont prêts ou rendus)`
      : `  cd ${shellPath(w.launchDir)} && ${resumeCommand(w.wave, ...[...w.lots, ...w.others].flatMap((l) => ['--drop', l.key]))}`,
  );
  return [
    `${command} : refusé — ${open.length > 1 ? `${open.length} vagues non terminées gardent` : 'une vague non terminée garde'} ouvert au moins un lot en cours de ce dépôt (${command === 'spec green' ? 'le commit de spec green posé' : 'un rescellé commité'} maintenant lui serait rendu comme « premier commit fautif » à la reprise de la vague) :`,
    ...lines,
    `Marche à suivre : clore chacun de ces lots dans sa vague (attendre les vivantes, retirer les lots des arrêtées), puis relancer ${command === 'spec green' ? 'spec green' : 'le rescellé'} :`,
    ...how,
  ].join('\n');
}

/**
 * Les vagues non terminées qui gardent ouvert un lot de `repo` encore en cours au plan (L238). Une vague range son état dans le dossier d'où elle a été lancée (`RunStore.runsDir(cwd)`),
 * souvent un dossier PARENT du dépôt (le dossier des projets) : on remonte donc de la racine du plan jusqu'à la racine du disque.
 */
function unfinishedWaves(root: string, repo: string, plan: Plan): OpenWave[] {
  const launchDirs = new Set<string>();
  for (let d = resolve(root); !launchDirs.has(d); d = dirname(d)) launchDirs.add(d);
  launchDirs.add(repo);
  const doing = new Set(plan.lots().filter((l) => l.status === 'doing').map((l) => l.id));
  const alive = liveWaves(cadenceHome());
  return [...launchDirs].flatMap((dir) => openWavesIn(dir, repo, (l) => doing.has(l.lot), alive));
}

/** La vague qui tient le verrou du dépôt rejoint la liste des vagues en cause, même quand l'état de ses lots ne dit rien (illisible, ou lots absents du plan) : le refus est unique et la nomme toujours. */
function withHolder(open: OpenWave[], holder: { wave: string; pid: number }, repo: string): OpenWave[] {
  const known = open.find((w) => w.wave === holder.wave);
  if (known) return open.map((w) => (w === known ? { ...w, live: true, pid: holder.pid } : w));
  const reg = liveWaves(cadenceHome()).find((w) => w.pid === holder.pid);
  const keys = openLotsIn(cadenceHome(), holder.pid, repo) ?? [];
  return [{ wave: holder.wave, launchDir: reg?.cwd ?? '', live: true, pid: holder.pid, lots: keys.map((key) => ({ key, status: 'ouvert' })), others: [] }, ...open];
}

/**
 * `cadence spec green <lot>` (L366) : un lot mené ou clos à la main (raf done) dont l'acceptation est restée à `vert: false` bloque toutes les vagues suivantes du dépôt.
 * Lance la commande dédiée (`orchestrate.accept`) comme le cycle ; verte, rescelle les tests mis au point depuis le commit rouge (`resealForGreen`), pose `vert: true` et commite le seul fichier, en citant le lot. Rouge : rien n'est changé, code 1.
 */
function specGreen(args: string[], ctx: { root: string; loadPlan: () => Plan; configPath: string; today: Day }, io: Io): number {
  if (args.length !== 1) throw new RafError('usage : cadence spec green <lot>');
  if (io.env.CADENCE_ORCHESTRATED) throw new RafError(`spec green refusé pendant une vague orchestrée (${io.env.CADENCE_ORCHESTRATED}) : c'est le travail du lead, hors session`);
  refuseWhileWaveHolds(ctx, 'spec green');
  const lotId = args[0]!;
  const plan = ctx.loadPlan();
  const lot = plan.lot(lotId);
  if (lot.status === 'todo') throw new RafError(`${lotId} n'est pas commencé (todo) : il n'a rien livré dont l'acceptation puisse passer au vert`);
  const repo = gitRoot(ctx.root) ?? ctx.root;
  const config = readOrchestrateConfig(ctx.configPath);
  if (!config.accept) throw new RafError(`orchestrate.accept absent de ${ctx.configPath} : sans la commande dédiée, il n'y a rien à lancer pour ${lotId}`);
  const json = findAcceptation(repo, config.spec.dir, lotId);
  if (!json) throw new RafError(`${lotId} : aucune acceptation sous ${config.spec.dir} (le lot n'a pas passé l'étape accept)`);
  const doc = parseAcceptation(readFileSync(join(repo, json), 'utf8'));
  if (typeof doc === 'string') throw new RafError(`${json} : ${doc}`);
  // Vert mais sans empreintes (L526, issue #20) : clos avant le scellement, il tient le verrou total sans qu'aucun chemin ne le scelle. On rejoue l'acceptation et, verte, on pose les empreintes.
  const mode = modeSpecGreen(doc);
  if (mode.deja) {
    io.out(`${lotId} : ${json} est déjà vert, rien à faire`);
    return 0;
  }
  const open = unfinishedWaves(ctx.root, repo, plan);
  if (open.length) throw new RafError(openWavesRefusal(open, 'spec green'));
  const dirty = git(repo, ['status', '--porcelain', '-z', '--', ...doc.fichiers]).split('\0').filter(Boolean).map((l) => l.slice(3));
  if (dirty.length) throw new RafError(`${lotId} : test(s) listé(s) modifié(s) sans être commités : ${dirty.join(', ')} — les commiter (en citant ${lotId}) avant de poser vert: true`);
  const { runs, orphans } = runAcceptation(repo, json, config.accept);
  if (orphans.length) throw new RafError(`fichiers listés dans ${json} sous la racine d'aucune commande de orchestrate.accept : ${orphans.join(', ')}`);
  const failed = runs.filter((r) => r.code !== 0);
  if (failed.length) {
    io.err(`${lotId} : tests d'acceptation encore rouges (${failed.map((r) => `${r.command}, code ${r.code}`).join(' ; ')}), ${json} ${mode.reste}`);
    for (const r of failed) io.err(r.output.trim().split('\n').slice(-40).join('\n'));
    return 1;
  }
  const before = readFileSync(join(repo, json), 'utf8');
  let sealed: ReturnType<typeof resealForGreen>;
  try {
    sealed = resealForGreen(repo, json, ctx.today);
  } catch (e) {
    throw new RafError(`${lotId} : ${(e as Error).message}`);
  }
  const resceles = sealed.refaits;
  setVert(repo, json); // déjà vrai pour un lot vert sans empreintes : le fichier garde ce qu'il avait
  try {
    git(repo, ['add', '--', json]);
    // Le sujet reste court et fixe (le gabarit `plan.commit` du projet s'il y en a un, comme tout commit écrit par cadence, L343) ; les tests rescellés, sans borne, vont dans le corps, une ligne chacun.
    const template = readPlanConfig(join(repo, 'cadence.yaml'), repo)?.commit;
    const subject = template ? planCommitMessage(template, { lot: lotId, action: mode.action }) : `chore(${lotId}): ${mode.action}`;
    const body = resceles.length ? ['empreintes rescellées (tests mis au point depuis le commit rouge) :', ...resceles.map((f) => `- ${f}`)].join('\n') : null;
    git(repo, ['commit', '-q', '-m', subject, ...(body ? ['-m', body] : []), '--', json]);
  } catch (e) {
    // Atomique, comme le rescellé : un commit refusé (hook pre-commit, ...) laisse le fichier tel qu'avant.
    writeFileSync(join(repo, json), before);
    try {
      git(repo, ['reset', '-q', '--', json]);
    } catch {
      // rien d'indexé : rien à défaire
    }
    const out = e as { stderr?: string; stdout?: string; message: string };
    throw new RafError(`spec green : le commit a échoué, ${json} est revenu tel qu'avant la commande — ${(out.stderr || out.stdout || out.message).trim().split('\n').slice(-5).join(' | ')}`);
  }
  io.out(`${lotId} : ${json} → ${mode.fait}${sealed.scelles.length ? ` (${sealed.scelles.join(', ')})` : ''}, commit ${git(repo, ['rev-parse', '--short', 'HEAD']).trim()}${resceles.length ? ` ; empreintes rescellées (tests mis au point depuis le commit rouge) : ${resceles.join(', ')}` : ''}`);
  return 0;
}

/** Un commit du lead en pleine passe ferait signaler au lot suivant un écart qui n'est pas le sien : tant qu'une vague tient le verrou du dépôt, `spec reseal` et `spec green` refusent. */
function refuseWhileWaveHolds(ctx: { root: string; loadPlan: () => Plan }, command: 'spec reseal' | 'spec green'): void {
  // Comme `deliver` : la vague tient le verrou du dépôt tant qu'un de ses lots y travaille (état illisible : on refuse).
  // Le refus est UN message : la vague vivante qui tient le verrou (à attendre) et les vagues arrêtées du dépôt, avec leurs dossiers et leurs commandes (L238).
  const orchestrating = waveHolding(ctx.root, command);
  if (orchestrating) {
    const repo = gitRoot(ctx.root) ?? ctx.root;
    let open: OpenWave[] = [];
    try {
      open = unfinishedWaves(ctx.root, repo, ctx.loadPlan());
    } catch {
      // plan illisible : le verrou seul motive le refus, la vague qui le tient est nommée
    }
    throw new RafError(openWavesRefusal(withHolder(open, orchestrating, repo), command));
  }
}

/**
 * `cadence spec reseal <lot> <test> --reason texte` (L200) : le chemin du lead quand un test d'acceptation scellé du lot EN COURS contredit la fiche.
 * Le test est corrigé dans l'arbre de travail (fiche inchangée, ou amendée et commitée par des commits du lot, L217) ; la commande refait l'empreinte de ce seul test, journalise la raison dans
 * acceptation.json, commite test + acceptation (le nouveau commit rouge), et note la raison au lot. Le verrou garde tout le reste.
 */
function specReseal(args: string[], reason: string | undefined, porteur: string | undefined, ctx: { root: string; loadPlan: () => Plan; configPath: string; today: Day }, io: Io): number {
  if (args.length !== 2 || !reason?.trim()) throw new RafError('usage : cadence spec reseal <lot> <test> --reason "pourquoi le test contredit la fiche" [--porteur <lot en cours>, pour un lot livré]');
  if (io.env.CADENCE_ORCHESTRATED) throw new RafError(`spec reseal refusé pendant une vague orchestrée (${io.env.CADENCE_ORCHESTRATED}) : c'est le travail du lead, hors session`);
  refuseWhileWaveHolds(ctx, 'spec reseal');
  const [lotId, test] = args as [string, string];
  const plan = ctx.loadPlan();
  const lot = plan.lot(lotId);
  const repo = gitRoot(ctx.root) ?? ctx.root;
  const dir = readOrchestrateConfig(ctx.configPath).spec.dir;
  const json = findAcceptation(repo, dir, lotId);
  // Un lot livré (acceptation verte) se rescelle pour un test instable dont le contrat ne change pas : le lot en cours qui porte la correction est nommé (--porteur) et cité dans le commit.
  const livre = lot.status !== 'doing' && !!json && ((a) => typeof a !== 'string' && a.vert)(parseAcceptation(readFileSync(join(repo, json), 'utf8')));
  if (lot.status !== 'doing' && !livre) throw new RafError(`${lotId} n'est pas en cours (${lot.status}) : le rescellé vaut pour le lot en cours, ou pour un lot livré dont l'acceptation est verte (vert: true) avec --porteur <lot en cours>`);
  if (porteur && lot.status === 'doing') throw new RafError(`--porteur n'a de sens que pour un lot livré : ${lotId} est en cours, son rescellé est cité sous son propre id`);
  if (livre && !porteur?.trim()) throw new RafError(`${lotId} est livré : --porteur <lot en cours> est obligatoire (le lot dont le commit porte la correction du test)`);
  if (livre && porteur) {
    if (porteur === lotId) throw new RafError(`--porteur doit être un autre lot que ${lotId} (le lot livré est clos)`);
    const carrier = plan.lot(porteur);
    if (carrier.status !== 'doing') throw new RafError(`--porteur ${porteur} n'est pas en cours (${carrier.status}) : le lot porteur est celui dont le commit porte la correction`);
  }
  const cite = livre ? (porteur as string) : lotId;
  if (!json) throw new RafError(`${lotId} : aucune acceptation sous ${dir} (le lot n'a pas passé l'étape accept)`);
  // Une vague non terminée (arrêtée sur une question ou le quota) garde ouverts des lots que son `--resume` rejouera : un rescellé commité entre-temps serait rendu à l'un d'eux comme « premier commit fautif » (L238).
  // Le verrou du rescellé couvre tous les lots ouverts du dépôt, pas seulement le porteur : on refuse dès qu'un lot DE CE DÉPÔT, encore en cours au plan, reste ouvert dans une vague non terminée.
  const open = unfinishedWaves(ctx.root, repo, plan);
  if (open.length) throw new RafError(openWavesRefusal(open, 'spec reseal'));
  const before = { json: readFileSync(join(repo, json), 'utf8'), test: existsSync(join(repo, test)) ? readFileSync(join(repo, test), 'utf8') : '' };
  let r: { avant: string; apres: string; ficheAmendee?: string };
  try {
    r = resealAcceptation(repo, json, test, reason, ctx.today, livre ? porteur : undefined, plan.refs, plan.lots().filter((l) => l.status === 'done').map((l) => l.id));
  } catch (e) {
    throw new RafError((e as Error).message);
  }
  const norm = posix.normalize(test);
  try {
    git(repo, ['add', '--', json, norm]);
    git(repo, ['commit', '-q', '-m', `test(${cite}): acceptation rescellée${livre ? ` du lot livré ${lotId}` : ''}, ${norm} : ${reason.trim()}${r.ficheAmendee ? ` (fiche amendée en ${r.ficheAmendee})` : ''}`, '--', json, norm]);
  } catch (e) {
    // Atomique : un commit refusé (hook pre-commit, ...) ne laisse ni empreinte refaite ni index à moitié prêt ; le test retrouve le texte du lead.
    writeFileSync(join(repo, json), before.json);
    writeFileSync(join(repo, norm), before.test);
    try {
      git(repo, ['reset', '-q', '--', json, norm]);
    } catch {
      // rien d'indexé : rien à défaire
    }
    const out = e as { stderr?: string; stdout?: string; message: string };
    throw new RafError(`spec reseal : le commit du rescellé a échoué, ${json} et ${norm} sont revenus tels qu'avant la commande (rien n'est rescellé) — ${(out.stderr || out.stdout || out.message).trim().split('\n').slice(-5).join(' | ')}`);
  }
  const sha = git(repo, ['rev-parse', '--short', 'HEAD']).trim();
  // Un plan tenu par un autre outil ne se modifie pas d'ici : la raison est déjà dans acceptation.json et dans le commit, la note reste à la main du lead.
  if (plan.readonly) {
    io.out(`${lotId} : ${norm} rescellé (${r.avant.slice(0, 7)} → ${r.apres.slice(0, 7)}), commit ${sha}${r.ficheAmendee ? `, fiche amendée en ${r.ficheAmendee}` : ''} ; raison dans ${json} et dans le commit — note à ajouter au lot ${cite} avec l'outil du projet (plan en lecture seule)`);
    return 0;
  }
  plan.note(cite, `test d'acceptation rescellé${livre ? ` (lot livré ${lotId}, ` : ' ('}${norm}, ${r.ficheAmendee ? `fiche amendée en ${r.ficheAmendee}` : 'fiche inchangée'}) : ${reason.trim()}`, ctx.today);
  try {
    plan.save();
  } catch (e) {
    // Le rescellé est commité (sha) : seul le plan est refusé (plan.onWrite en échec), il reste inchangé et la note n'est pas écrite ; dire « écriture refusée » seul laisserait croire que rien n'a été fait.
    throw new RafError(`spec reseal : le rescellé a eu lieu (commit ${sha}) mais la note du lot n’a pas été écrite, le plan est inchangé — ${(e as Error).message} — relancer la commande dit « rien à resceller » : ajouter la note à la main (raf note ${cite}) une fois le plan réparé`);
  }
  // La note du lot rejoint le dépôt dans la foulée (un dépôt sale arrêterait la vague suivante) ; un plan hors du dépôt ou non suivi reste à la main du lead.
  const planRel = relative(repo, plan.path);
  const produced = plan.produced;
  const tracked = !planRel.startsWith('..') && git(repo, ['ls-files', '--', planRel]).trim() !== '';
  if (tracked) {
    try {
      // Les fichiers de plan.onWrite (L346) partent avec la note : la commande a tourné à l'écriture du plan.
      const withPlan = [planRel, ...dirtyPaths(repo, produced)];
      git(repo, ['add', '--', ...withPlan]);
      git(repo, ['commit', '-q', '-m', planCommitMessage(readPlanConfig(join(repo, 'cadence.yaml'), repo)?.commit, { lot: cite, action: PLAN_ACTIONS.resealed(norm) }), '--', ...withPlan]);
    } catch (e) {
      // Le rescellé est fait (commit ${sha}) : on ne le défait pas, on dit où en est la note, au lieu d'une pile d'appels.
      const out = e as { stderr?: string; stdout?: string; message: string };
      throw new RafError(`spec reseal : le rescellé a eu lieu (commit ${sha}) mais le commit de la note du lot a échoué — la note est écrite dans ${planRel}, à commiter à la main (un plan sale arrêterait la vague suivante) — ${(out.stderr || out.stdout || out.message).trim().split('\n').slice(-5).join(' | ')}`);
    }
  }
  io.out(`${lotId} : ${norm} rescellé (${r.avant.slice(0, 7)} → ${r.apres.slice(0, 7)}), commit ${sha}${r.ficheAmendee ? `, fiche amendée en ${r.ficheAmendee}` : ''} ; raison dans ${json} et en note du lot ${cite}${tracked ? '' : ' (plan à commiter)'}`);
  return 0;
}

/** `cadence spec check|qa <fiche>` (L170) : code 0 valide, 1 écarts, 2 usage ou fichier illisible. `qa` imprime la section expectations.md de l'écran. */
function spec(rest: string[], io: Io): number {
  const sub = rest[0];
  if ((sub !== 'check' && sub !== 'qa') || rest.length !== 2) throw new RafError('usage : cadence spec check|qa <fiche.yaml>');
  const doc = readFiche(resolve(io.cwd, rest[1]!));
  const problems = checkFiche(doc);
  if (sub === 'qa') {
    // les écarts vont sur la sortie d'erreur : la sortie standard est la section, qu'on redirige vers le fichier
    for (const m of problems) io.err(`✗ ${m}`);
    if (problems.length > 0) return 1;
    io.out(deriveQa(doc).trimEnd());
    return 0;
  }
  for (const m of problems) io.out(`✗ ${m}`);
  if (problems.length > 0) {
    io.out(`${problems.length} écart(s)`);
    return 1;
  }
  io.out(summary(doc as Record<string, unknown>));
  return 0;
}

/** raf spec <id> on|off, spec green <lot>, spec reseal <lot> <test> : le verbe de raf et les deux chemins du lead. */
export function cmdSpec(c: Ctx): number | Promise<number> {
  const green = c.rest[0] === 'green';
  const reseal = c.rest[0] === 'reseal';
  const { rest, values, io, today, root, configPath, loadPlan } = c;
  if (green) return specGreen(rest.slice(1), { root, loadPlan, configPath, today }, io);
  if (reseal) return specReseal(rest.slice(1), values.reason, values.porteur, { root, loadPlan, configPath, today }, io);
  if (rest.length !== 2 || (rest[1] !== 'on' && rest[1] !== 'off')) throw new RafError('usage : raf spec <id> on|off (ou cadence spec check|qa <fiche.yaml>)');
  const plan = loadPlan();
  if (!plan.setSpec(rest[0], rest[1] === 'on')) {
    io.out(`${rest[0]} a déjà screen: page — l'écran implique la spec, rien à changer`);
    return 0;
  }
  plan.save();
  return 0;
}

/** `spec` est aussi un verbe de raf (raf spec <id> on|off, L186) : seuls check et qa vont à la fiche, sans lire le plan ; null pour les autres. */
export function cmdSpecChecks(c: EarlyCtx): number | null {
  return c.rest[0] === 'check' || c.rest[0] === 'qa' ? spec(c.rest, c.io) : null;
}
