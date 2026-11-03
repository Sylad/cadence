import { toolBinOf } from '../snapshot.js';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { articleRepoDir } from '../../docsync.js';
import { PROBE_FAILED } from '../probe.js';
import { changedFiles, isAncestor, readCommits, restoreWorktree, tryGit } from '../../git.js';
import { blockingLots, gitCommitsIn } from '../table.js';
import { type LotRepo } from '../../repos.js';
import { SlotAbandoned } from '../registry.js';
import { journalTokens, peakContext, mcpServersFor, playwrightDir, runSession, writeMcpConfig, enabledPlugins, settingsFiles, type AnyModel, type SessionKind, type StepModel } from '../launch.js';
import { pushed, remoteAdvances, snapshot, type Snapshot } from '../guard.js';
import { sumTokens, type Tokens } from '../result.js';
import { cutReport, EXTENSION_MS, MAX_EXTENSIONS, workTimeoutMs } from '../timeouts.js';
import { checkShape, effortKey, REVIEW_SCHEMA, schemaFor, summarize, stepAgent, type ReviewReport } from '../schemas.js';
import { lotKey, lotRepoPaths, neighbourDirs, type StepState } from '../state.js';
import { readTier, stillThird, takeTiers, tierMoved, tierRepos, wipBranch, type TierRead } from '../tiers.js';
import { git, gitFailure, planFileSet } from '../worktree.js';
import { type LotCtx, workDir as wd, save, transition, escalatedSession, stop, hasSpecStage } from './ctx.js';
import { lotOver, WRITE_STEPS, fixAffordable, dropped, DROPPED, unplayedAnswer, halted, overBudget, suspend } from './budget.js';
import { trackedPaths } from './plan-writes.js';
import { docsConfig, briefFor } from './brief.js';

/** Les dépôts voisins du lot, vus avant et après une session. */
type Others = { repo: LotRepo; before: Snapshot; after: Snapshot }[];

export type Done = { step: StepState; report: unknown; before: Snapshot; after: Snapshot; others: Others };

/** Modèle d'une revue (L108) : la revue légère d'un lot léger tant qu'aucune correction n'a eu lieu, sinon la revue complète (UX comprise). */
function reviewModel(c: LotCtx, kind: SessionKind): AnyModel {
  const { light, full } = c.config.review;
  // Escalade (L337) : la revue neuve qui suit la correction escaladée se joue au modèle de l'escalade ; l'UX garde le sien.
  if (c.lot.escalation?.stage === 'fix' && (kind === 'review' || kind === 'review-small')) return c.lot.escalation.model;
  return c.lot.light && c.lot.pass === 0 && (kind === 'review' || kind === 'review-small') ? light : full;
}

/** Écarte le modèle local pour le reste de la vague (L322) : le premier échec suffit, les lots suivants n'attendent pas de le constater à leur tour. */
export function benchLocal(c: LotCtx, cause: string): void {
  c.wave.localOut ??= cause.slice(0, 200);
}

/** Rendu par `session(…, true)` quand l'étape locale n'a rien donné (Ollama éteint, délai, rapport sans structure) : l'appelant se replie sur Sonnet (L146). */
export const LOCAL_FAILED = Symbol('local-failed');

/** Une session : budget et quota vérifiés avant, état écrit avant et après, journal gardé, contrôles du dépôt après. */
export async function session(c: LotCtx, kind: 'probe'): Promise<Done | null | typeof PROBE_FAILED>;
export async function session(c: LotCtx, kind: SessionKind, local: true): Promise<Done | null | typeof LOCAL_FAILED>;
export async function session(c: LotCtx, kind: SessionKind, local?: false): Promise<Done | null>;
export async function session(c: LotCtx, kind: SessionKind, local = false): Promise<Done | null | typeof LOCAL_FAILED | typeof PROBE_FAILED> {
  const w = c.wave;
  const l = c.lot;
  if (dropped(c)) return stop(c, 'handed-back', DROPPED + unplayedAnswer(l));
  const halt = halted(w, l);
  if (halt) return suspend(c, halt);
  const write = kind === 'probe' || WRITE_STEPS.includes(kind); // la sonde écrit (ses tests) mais le budget ne la borne pas : il est vérifié avant de la décider
  // Le budget du lot borne l'écriture, jamais la revue (L145) : une revue est jouée dès que le code est à relire (sauf tests rouges après une écriture, cf. REVIEW_RESERVE), la passe fix réserve son coût.
  if (WRITE_STEPS.includes(kind) && (lotOver(l) || (kind === 'fix' && !fixAffordable(l)))) return overBudget(c, kind === 'fix' && !lotOver(l));

  const model: StepModel = ['spec', 'accept', 'fiche', 'probe'].includes(kind) ? 'sonnet' : write ? (kind === 'fix' && l.escalation?.stage === 'fix' ? l.escalation.model : l.model) : local ? 'local' : kind === 'precheck' ? 'sonnet' : reviewModel(c, kind); // le contrôle préalable ne fait que lire : pas d'Opus
  const effort = c.config.effort[effortKey(kind)];
  const before = await snapshot(wd(c));
  const neighbours = l.repos ?? [];
  const beforeOthers = await Promise.all(neighbours.map((r) => snapshot(r.path)));
  const tiersBefore = write ? takeTiers(thirdRepos(c), (line) => w.log(`${lotKey(l.project, l.lot)} · ${line}`)) : null;
  const n = l.steps.length + 1;
  const sessionId = randomUUID();
  const step: StepState = { n, kind, model, ...(effort !== 'default' ? { effort } : {}), status: 'running', sessionId, started: new Date().toISOString(), headBefore: before.head ?? undefined };
  l.steps.push(step);
  const label = { implement: 'implementing', fix: 'fixing', review: 'reviewing', ux: 'reviewing', 'review-small': 'reviewing', precheck: 'implementing', spec: 'implementing', accept: 'implementing', maquette: 'reviewing', fiche: 'reviewing', probe: 'implementing' } as const;
  transition(c, label[kind]);
  w.log(`${lotKey(l.project, l.lot)} · session ${n} ${kind} (${model})`);

  let brief: string;
  try {
    brief = briefFor(c, kind, local);
  } catch (e) {
    step.status = 'failed';
    step.cause = (e as Error).message;
    return stop(c, 'failed', `brief de ${kind} : ${(e as Error).message}`);
  }
  const mcpConfig = writeMcpConfig(w.store.lotDir(l.project, l.lot), kind, l.visible, l.small, !!l.screen);
  const playwright = !!mcpServersFor(kind, l.visible, '', l.small, !!l.screen).playwright;
  if (playwright) l.uxCaptures = join(dirname(mcpConfig), 'playwright');
  const answerInBrief = l.pendingAnswer; // gardée pour la rendre si la session ne part jamais (créneau abandonné, L332)
  if (answerInBrief && kind === 'fix') step.answered = true;
  l.pendingAnswer = null; // la réponse est dans le brief : elle ne repart pas avec la session suivante
  const tmpDir = w.store.tmpDir(l.project, l.lot); // TMPDIR de la session, aussi en --add-dir : hors du cwd, un Write y serait refusé en `claude -p`
  // Délai (L298) : l'étape d'écriture est proportionnée à l'estimate et à la fiche du lot, puis prolongée à chaque échéance où elle a commité.
  const delay = write ? workTimeoutMs(c.config.timeouts.work, l.estimate, hasSpecStage(l)) : c.config.timeouts.review;
  let seenHead = before.head;
  const extend = write
    ? {
        progressed: () => {
          const head = (() => {
            try {
              return git(wd(c), 'rev-parse', 'HEAD').trim();
            } catch {
              return seenHead;
            }
          })();
          const moved = head !== seenHead;
          seenHead = head;
          return moved;
        },
        ms: EXTENSION_MS,
        max: MAX_EXTENSIONS,
      }
    : undefined;
  const outcome = await runSession(
    {
      kind,
      sessionId,
      brief,
      model: local ? 'sonnet' : (model as AnyModel),
      effort,
      local,
      schema: schemaFor(kind),
      agent: stepAgent(kind, l.docsFix),
      cwd: wd(c),
      wave: w.id,
      lot: lotKey(l.project, l.lot),
      permissionMode: c.config.permissionMode,
      prodAccess: c.config.prodAccess,
      addDirs: [...c.config.addDirs, ...(playwright && write ? [playwrightDir(dirname(mcpConfig))] : []), tmpDir, ...neighbourDirs(l), ...(kind === 'fix' && l.docsFix ? (docsConfig(c).articles ?? []).map((r) => articleRepoDir(l.repo, r)) : [])],
      nodeBin: l.node?.link,
      testWorkers: w.testWorkers,
      toolBin: toolBinOf(w.store.dir),
      tmpDir,
      mcpConfig,
      playwright,
      disablePlugins: enabledPlugins(settingsFiles(w.claudeHome, wd(c))),
      timeoutMs: delay,
      extend,
    },
    {
      claude: w.claude,
      agents: w.agents,
      onSpawn: (pid) => {
        step.pid = pid;
        save(c);
      },
      // La session neuve de la relance (L256) devient la session de l'étape dès son lancement : un signal pendant qu'elle tourne la tue (killSessions) et compte ses jetons (countInterrupted).
      onRelaunch: (id) => {
        step.sessionId = id;
        save(c);
      },
    },
  ).catch((e: unknown) => {
    if (e instanceof SlotAbandoned) return e;
    throw e;
  });
  if (outcome instanceof SlotAbandoned) {
    // L332 : la demande est arrivée pendant l'attente d'un créneau. Une étape qui n'a pas démarré (aucun pid) n'a pas eu lieu : elle ne figure pas à l'état.
    // Rien de ce que le brief a consommé n'a servi : la réponse du lead (retirée de pendingAnswer avant le lancement) revient, la reprise rejoue l'étape avec elle.
    if (step.pid === undefined) {
      l.steps.pop();
      l.pendingAnswer = answerInBrief;
    } else {
      // Une session de l'étape a déjà tourné (le pid est le sien) et c'est son lancement SUIVANT qui attendait un créneau (relance d'une session coupée, relance de mise en forme) :
      // sa sortie, son identifiant et ses jetons sont gardés, la cause dit ce qui n'a pas eu lieu.
      const dir = w.store.lotDir(l.project, l.lot);
      const base = `${n}-${kind}`;
      const after = outcome.after;
      const spentOf = (sessionId: string): Tokens | null => (w.claudeHome ? (journalTokens(w.claudeHome, wd(c), sessionId)?.tokens ?? null) : null);
      let tokens: Tokens | null = null;
      let cause = outcome.message;
      if (after?.relaunched) {
        const cutRun = after.relaunched;
        tokens = spentOf(cutRun.sessionId);
        step.sessionId = cutRun.sessionId; // la session neuve n'a jamais démarré : l'étape est celle de la session coupée
        writeFileSync(join(dir, `${base}.first.err`), cutRun.stderr);
        cause = `coupée (${cutRun.cause}), relance en session neuve non faite : ${outcome.message}`;
        l.warnings.push(`${kind} coupée (${cutRun.cause}) : sa relance en session neuve n'a pas eu lieu, ${outcome.message}`);
      } else if (after?.formatting) {
        const first = after.formatting;
        tokens = first.tokens ?? (first.sessionId ? spentOf(first.sessionId) : null);
        if (first.sessionId) step.sessionId = first.sessionId;
        writeFileSync(join(dir, `${base}.first.json`), first.stdout);
        writeFileSync(join(dir, `${base}.first.err`), first.stderr);
        cause = `sortie sans structured_output, relance de mise en forme non faite : ${outcome.message}`;
      }
      if (tokens && !local) {
        step.tokens = tokens;
        w.budget.add(tokens);
      }
      step.status = 'failed';
      step.cause = cause;
      step.ended = new Date().toISOString();
      w.saveWave();
    }
    return outcome.reason === DROPPED ? stop(c, 'handed-back', DROPPED + unplayedAnswer(l)) : suspend(c, outcome.reason);
  }
  step.ended = new Date().toISOString();
  const dir = w.store.lotDir(l.project, l.lot);
  const base = `${n}-${kind}`;

  // Jetons de la session coupée (L256) : au budget de la vague ci-dessous, et à l'étape pour que le lot (L78) et le tableau les comptent.
  let cutTokens: Tokens | null = null;
  if (outcome.relaunched) {
    // Étape en lecture coupée (signal, sortie vide) puis relancée en session neuve (L256) : la session coupée a consommé des jetons (son journal), garde sa sortie d'erreur, et la relance est signalée au tableau.
    const cutRun = outcome.relaunched;
    const spent = w.claudeHome ? journalTokens(w.claudeHome, wd(c), cutRun.sessionId) : null;
    if (spent) {
      w.budget.add(spent.tokens);
      cutTokens = spent.tokens;
    }
    writeFileSync(join(dir, `${base}.first.err`), cutRun.stderr);
    const text = `${kind} relancée en session neuve après une coupure (${cutRun.cause})`;
    l.warnings.push(text);
    w.log(`${lotKey(l.project, l.lot)} · session ${n} ${text}`);
    w.saveWave();
  }
  if (outcome.kind !== 'ok' && !local) {
    // Une session en échec, au quota ou tuée au délai a consommé des tokens : ceux de sa sortie, sinon ceux de son journal.
    const spent = outcome.tokens ? { tokens: outcome.tokens, sessionId: outcome.sessionId } : w.claudeHome ? journalTokens(w.claudeHome, wd(c), outcome.sessionId ?? sessionId) : null;
    if (spent) {
      step.tokens = cutTokens ? sumTokens(cutTokens, spent.tokens) : spent.tokens;
      if (spent.sessionId) step.sessionId = spent.sessionId;
      w.budget.add(spent.tokens);
      w.saveWave();
      if (w.claudeHome && spent.sessionId) step.peakContext = peakContext(w.claudeHome, wd(c), spent.sessionId);
    } else if (cutTokens) {
      step.tokens = cutTokens;
    }
  }
  if (local && outcome.kind !== 'ok') {
    // Hors quota Anthropic : rien au budget (ni sortie, ni journal), et jamais d'arrêt du lot — Sonnet reprend le contrôle.
    // Un appel d'outil écrit en texte (`<function=Bash>`) est une sortie sans structured_output : le local n'a pas tenu l'appel d'outils, inutile d'attendre un second tour.
    const textCall = outcome.kind === 'failed' && outcome.stdout.includes('<function=');
    const cause = textCall ? 'appel d\'outil écrit en texte, pas de structured_output' : outcome.kind === 'failed' ? outcome.cause : outcome.message;
    writeFileSync(join(dir, `${base}.json`), outcome.kind === 'failed' ? outcome.stdout : '');
    if (outcome.kind === 'failed') writeFileSync(join(dir, `${base}.err`), outcome.stderr);
    step.status = 'failed';
    step.cause = cause;
    step.report = `${base}.json`;
    delete step.tokens;
    l.warnings.push(`contrôle préalable : modèle local sans résultat (${cause.slice(0, 200)}), repli sur Sonnet`);
    benchLocal(c, cause);
    save(c);
    return LOCAL_FAILED;
  }
  if (outcome.kind === 'failed') {
    if (outcome.firstStdout !== undefined) writeFileSync(join(dir, `${base}.first.json`), outcome.firstStdout);
    writeFileSync(join(dir, `${base}.json`), outcome.stdout);
    writeFileSync(join(dir, `${base}.err`), outcome.stderr);
    step.report = `${base}.json`;
    // Un commit sur la branche principale d'un dépôt tiers se dit aussi quand la session est en échec ou coupée au délai : sinon la relance le prendrait pour référence.
    if (tiersBefore && checkTiers(c, kind, step, tiersBefore)) return null;
    step.status = 'failed';
    step.cause = outcome.cause;
    if (kind === 'probe') {
      // R9 : une sonde en échec ou coupée ne rend pas le lot. Ce qu'elle a laissé non commité est remis (suivis restaurés, nouveaux fichiers retirés), un warning le nomme.
      // Coupée entre `git add` et son commit, elle laisse aussi l'index : il est désindexé d'abord, `restoreWorktree` ne remet que l'arbre de travail (sinon « AD q.spec.ts » et le lot rendu pour arbre sale).
      // Un fichier à la fois : un chemin inconnu de l'index (non indexé) fait refuser toute la commande, les autres resteraient indexés.
      const left = dirtBetween(before, await snapshot(wd(c)));
      if (left.length) {
        for (const f of left) tryGit(wd(c), ['restore', '--staged', '--', f]);
        restoreWorktree(wd(c), left);
        l.warnings.push(`sonde de cas limites : fichiers non commités laissés par la session retirés (${left.join(', ')})`);
      }
      return PROBE_FAILED;
    }
    if (write && outcome.cause === 'délai dépassé') {
      // L298 : le travail laissé par une étape d'écriture coupée au délai est signalé (commits, fichiers, tests), pas un « échec » sec ; L303 : dans les dépôts voisins aussi.
      const repos = [{ rel: '', path: wd(c), before }, ...neighbours.map((r, i) => ({ rel: r.rel, path: r.path, before: beforeOthers[i] }))];
      const files: string[] = [];
      let commits = 0;
      let numstat = '';
      for (const r of repos) {
        const after = await snapshot(r.path);
        files.push(...dirtBetween(r.before, after).map((f) => (r.rel ? `${r.rel}: ${f}` : f)));
        if (r.before.head) commits += readCommits(r.path, { range: `${r.before.head}..HEAD` }).length;
        try {
          numstat += git(r.path, 'diff', '--numstat', 'HEAD');
        } catch {
          // pas de HEAD : aucune ligne comptée
        }
        numstat += '\n';
      }
      const report = cutReport({ minutes: Math.round(delay / 60_000), commits, files, numstat });
      step.cause = report;
      return stop(c, files.length || commits ? 'handed-back' : 'failed', `délai dépassé : ${kind} ${report}`, escalatedSession(c, kind));
    }
    return stop(c, 'failed', outcome.cut ? `coupure : ${kind} ${outcome.cause}` : `échec : ${kind} sans résultat : ${outcome.cause}`, escalatedSession(c, kind));
  }
  if (outcome.kind === 'quota') {
    if (outcome.firstStdout !== undefined) writeFileSync(join(dir, `${base}.first.json`), outcome.firstStdout);
    w.quota = { hit: true, message: outcome.message };
    if (tiersBefore && checkTiers(c, kind, step, tiersBefore)) return null;
    step.status = 'interrupted';
    step.cause = outcome.message;
    w.saveWave();
    c.lot.next = kind;
    transition(c, 'suspended', 'quota atteint');
    return null;
  }

  const res = outcome.result;
  if (outcome.firstStdout !== undefined) writeFileSync(join(dir, `${base}.first.json`), outcome.firstStdout);
  writeFileSync(join(dir, `${base}.json`), JSON.stringify({ ...res, structured: res.structured }, null, 2));
  step.report = `${base}.json`;
  step.sessionId = res.sessionId;
  step.tokens = local ? { ...res.tokens, counted: 0 } : cutTokens ? sumTokens(cutTokens, res.tokens) : res.tokens; // local : hors quota, hors budget
  if (res.formattingRetry) {
    step.formatRetry = true;
    w.log(`${lotKey(l.project, l.lot)} · session ${n} ${kind} : rapport sans sortie structurée, relance de mise en forme`);
  }
  if (!local) w.budget.add(res.tokens);
  w.saveWave();
  if (w.claudeHome) step.peakContext = peakContext(w.claudeHome, wd(c), res.sessionId);

  const after = await snapshot(wd(c));
  const afterOthers = await Promise.all(neighbours.map((r) => snapshot(r.path)));
  const others: Others = neighbours.map((repo, i) => ({ repo, before: beforeOthers[i], after: afterOthers[i] }));
  step.headAfter = after.head ?? undefined;
  // Le dépôt du projet d'abord, puis chaque voisin : mêmes contrôles, l'incident nomme le dépôt voisin.
  const watched = [{ where: '', path: wd(c), repo: c.lot.repo, before, after }, ...others.map((o) => ({ where: ` dans ${o.repo.rel}`, path: o.repo.path, repo: o.repo.path, before: o.before, after: o.after }))];
  // Les incidents d'abord, dans TOUS les dépôts surveillés (projet et voisins) : un push ou un hook de garde supprimé où que ce soit arrête la vague, avant tout traitement d'un HEAD déplacé ou d'un lot rendu (L214).
  for (const { where, repo, before: b, after: a } of watched) {
    const delivered = pushed(b, a) ? leadDelivery(c, repo, b, a) : null;
    if (delivered) w.log(`${lotKey(l.project, l.lot)} · session ${n} ${kind} : push du lead (livraison ${delivered.length ? `de ${delivered.join(', ')}` : 'du plan'}) toléré${where}`);
    else if (pushed(b, a)) {
      step.status = 'failed';
      step.cause = `push détecté${where}`;
      w.incident = `push détecté${where} pendant ${lotKey(l.project, l.lot)} (${kind})`;
      w.saveWave();
      return stop(c, 'failed', `incident : ${w.incident}`);
    }
    if (b.guard && !a.guard) {
      step.status = 'failed';
      step.cause = `le hook pre-push de garde a disparu${where}`;
      w.incident = `le hook pre-push de garde a été supprimé${where} pendant ${lotKey(l.project, l.lot)} (${kind})`;
      w.saveWave();
      return stop(c, 'failed', `incident : ${w.incident}`);
    }
  }
  if (tiersBefore && checkTiers(c, kind, step, tiersBefore)) return null;
  for (const { where, path, before: b, after: a } of watched) {
    // Session d'écriture finie sur une autre branche ou en HEAD détaché (L214) : pas un push, mais les contrôles et le lot suivant partiraient d'un HEAD qui n'est plus la branche du lot.
    if (write && b.branch !== a.branch) {
      const was = `${a.branch ? `sur la branche ${a.branch}` : `en HEAD détaché (${(a.head ?? '').slice(0, 7)})`} au lieu de ${b.branch ?? 'HEAD détaché'}`;
      const why = b.branch ? headStranded(path, b, a) : 'le dépôt n\'était pas sur une branche au départ';
      // La remise peut échouer (index.lock, fichier en conflit) : le lot est rendu, l'orchestrateur ne s'arrête pas (L214).
      let failed: string | null = null;
      if (b.branch && why === null) {
        try {
          git(path, 'checkout', '-q', b.branch);
        } catch (e) {
          failed = `HEAD déplacé — remise de la branche ${b.branch} impossible : ${gitFailure(e)}`;
        }
      }
      if (b.branch && why === null && failed === null) {
        Object.assign(a, await snapshot(path));
        if (path === wd(c)) step.headAfter = a.head ?? undefined;
        const text = `${kind} : la session a fini${where} ${was} (arbre propre, rien hors de la branche) — branche ${b.branch} remise`;
        l.warnings.push(text);
        w.log(`${lotKey(l.project, l.lot)} · ${text}`);
      } else if (!b.branch) {
        const text = `${kind} : la session a fini${where} ${was} — ${why}`;
        l.warnings.push(text);
        w.log(`${lotKey(l.project, l.lot)} · ${text}`);
      } else {
        step.status = 'failed';
        step.cause = failed ? `${failed}${where}` : `HEAD déplacé${where}`;
        (w.dirtyRepos ??= new Map()).set(path, lotKey(l.project, l.lot));
        (w.movedRepos ??= new Set()).add(path);
        return stop(c, 'handed-back', `incident : HEAD déplacé${where} pendant ${lotKey(l.project, l.lot)} (${kind}) : la session a fini ${was} et ${failed ?? why}`);
      }
    }
    // Étape en lecture seule qui n'a laissé que des fichiers NON SUIVIS (captures d'un script en chemin relatif, L162) : déplacés dans le dossier du lot, avertissement, le verdict est gardé.
    if (!write && b.head === a.head && b.tracked.join() === a.tracked.join() && b.untracked.join() !== a.untracked.join() && b.untracked.every((f) => a.untracked.includes(f))) {
      const fresh = a.untracked.filter((f) => !b.untracked.includes(f)).map(unquotePath);
      const stray = join(dir, 'stray');
      const to = where ? join(stray, relative(wd(c), path).replace(/[\\/]/g, '_')) : stray;
      const moved = moveStray(path, fresh, to);
      if (moved.length) {
        const text = `${kind} : ${moved.length} fichier(s) non suivi(s) laissé(s)${where} par une étape en lecture seule, déplacé(s) dans ${to} : ${moved.join(', ')}`;
        c.lot.warnings.push(text);
        w.log(`${lotKey(l.project, l.lot)} · ${text}`);
      }
      if (moved.length === fresh.length) continue;
      // Déplacement partiel : l'incident ne nomme que ce qui reste dans le dépôt.
      return handBack(c, kind, res.structured, step, where, path, b, a, fresh.filter((f) => !moved.includes(f)));
    }
    if (!write && (b.head !== a.head || b.tracked.join() !== a.tracked.join() || b.untracked.join() !== a.untracked.join())) {
      return handBack(c, kind, res.structured, step, where, path, b, a);
    }
  }
  const touched = write && c.tree?.active ? planTouched(c, before.head, after) : null;
  if (touched) {
    step.status = 'failed';
    step.cause = touched;
    return stop(c, 'handed-back', `la session a modifié le plan dans son worktree ${touched} : le plan n'est écrit que par le programme ; worktree conservé : ${wd(c)}`);
  }
  step.status = 'ok';
  save(c);
  return { step, report: res.structured, before, after, others };
}

/** Les dépôts tiers d'un lot (L456) : frères du dépôt du lot, hors voisins déclarés et dépôts des autres lots de la vague (leur branche principale bouge légitimement, R14). Une vague lancée après ce relevé, comme le lead ou une livraison, n'est pas dans la liste : seuls les commits qui citent un lot de cette vague sont constatés (L458) ; exclure les vagues vivantes déjà connues évite qu'un identifiant de lot commun (deux projets, chacun son L1) fasse passer leurs commits pour les nôtres. */
function thirdRepos(c: LotCtx): string[] {
  const mine = lotKey(c.lot.project, c.lot.lot);
  const others = [...c.wave.store.lots().filter((x) => lotKey(x.project, x.lot) !== mine), ...c.wave.store.liveWaveLots()].flatMap(lotRepoPaths);
  return tierRepos(c.lot.repo, [...neighbourDirs(c.lot), ...others]);
}

/**
 * Fin d'une session d'écriture (L456) : la branche principale d'un dépôt tiers a-t-elle bougé ? Alors le lot est rendu avec le constat, le commit n'est pas défait,
 * le dépôt est marqué sale pour la vague. Un tiers resté sur la branche wip du lot est dit en avertissement, sans être remis. Un dépôt illisible ou sans branche
 * principale des deux côtés est ignoré, au journal. Vrai quand le lot est rendu : la session s'arrête là.
 */
function checkTiers(c: LotCtx, kind: SessionKind, step: StepState, before: Map<string, TierRead>): boolean {
  const l = c.lot;
  const w = c.wave;
  const key = lotKey(l.project, l.lot);
  const wip = wipBranch(l.project, l.lot);
  for (const [repo, b] of stillThird(before, w.store.lots(), key)) {
    const name = basename(repo);
    let a: TierRead;
    try {
      a = readTier(repo);
    } catch (e) {
      w.log(`${key} · dépôt tiers ${name} ignoré : lecture impossible (${gitFailure(e)})`);
      continue;
    }
    if (!Object.keys(b.mains).length && !Object.keys(a.mains).length) {
      w.log(`${key} · dépôt tiers ${name} ignoré : aucune branche principale`);
    } else {
      const moved = tierMoved(repo, b, a, w.store.lots().map((x) => x.lot));
      if (moved) {
        step.status = 'failed';
        step.cause = `commit sur la branche principale d'un autre dépôt (${name}, ${moved.branch})`;
        (w.dirtyRepos ??= new Map()).set(repo, key);
        stop(c, 'handed-back', `incident : commit sur la branche principale d'un autre dépôt (${name}, ${moved.branch}) pendant ${key} (${kind}) : ${moved.detail} ; la voie est la branche ${wip}`);
        return true;
      }
    }
    if (a.branch === wip && b.branch !== wip) {
      const text = `${kind} : la session a laissé le dépôt tiers ${name} sur la branche ${wip} ; elle n'est pas remise`;
      l.warnings.push(text);
      w.log(`${key} · ${text}`);
    }
  }
  return false;
}

/**
 * Une session d'écriture a-t-elle touché, dans son worktree, le fichier de plan ou un fichier généré avec lui (plan.files, la page Gantt) ? (R21) Le plan n'est
 * écrit que par le programme, dans le dépôt du projet : un commit de plan sur la branche du lot reviendrait en conflit au rebase. Rend « (fichier, commit sha) »
 * ou « (fichier, non commité) », null sinon.
 */
function planTouched(c: LotCtx, headBefore: string | null, after: Snapshot): string | null {
  const files = planFileSet(c.loadPlan(), c.lot.repo);
  if (headBefore && after.head && headBefore !== after.head) {
    for (const sha of git(wd(c), 'log', '--format=%H', `${headBefore}..${after.head}`).split('\n').filter(Boolean)) {
      const hit = changedFiles(wd(c), sha).find((f) => files.has(f));
      if (hit) return `(${hit}, commit ${sha.slice(0, 7)})`;
    }
  }
  const dirty = trackedPaths(after).find((f) => files.has(f));
  return dirty ? `(${dirty}, non commité)` : null;
}

/** Pourquoi la branche de départ ne peut pas être remise sans risque après un HEAD déplacé (L214), null si elle le peut : arbre propre et rien hors de la branche. */
function headStranded(path: string, b: Snapshot, a: Snapshot): string | null {
  if (a.tracked.length || a.untracked.join() !== b.untracked.join()) return 'l\'arbre n\'est pas propre';
  // Le HEAD final, et chaque position prise par HEAD pendant la session (reflog) : un commit fait en chemin puis quitté n'est plus que dans le reflog.
  let seen: string[] = [];
  try {
    seen = git(path, 'reflog', '--format=%H', `-n${Math.max(0, a.reflog - b.reflog)}`, 'HEAD').split('\n').filter(Boolean);
  } catch {
    // reflog illisible : le HEAD final seul juge
  }
  for (const sha of [a.head ?? 'HEAD', ...seen]) {
    try {
      git(path, 'merge-base', '--is-ancestor', sha, `refs/heads/${b.branch}`);
    } catch {
      return `des commits ne sont pas dans la branche ${b.branch}`;
    }
  }
  return null;
}

/**
 * Le push du lead pour livrer un lot prêt de la vague (L352) : `git push origin <sha>:main`, le chemin « livrable jusqu'à <sha> » du skill lead.
 * Toléré quand chaque branche distante qui a bougé avance en avant (ou est créée) vers un sha ancêtre du HEAD du dépôt et que ce sha ne contient aucun
 * commit d'un lot de la vague qui n'est pas prêt (la garde de `deliver --sha`, `blockingLots`) : ne restent que des commits de lots prêts ou du plan.
 * Renvoie les lots prêts livrés (vide : du plan seulement) ; null pour tout autre push, qui reste un incident — dont une branche supprimée, un push
 * forcé, un sha hors de l'histoire de HEAD ou des commits d'un lot en cours ou illisibles.
 */
function leadDelivery(c: LotCtx, repo: string, before: Snapshot, after: Snapshot): string[] | null {
  const moved = remoteAdvances(before, after);
  if (!moved) return null;
  const lots = c.wave.store.lots().filter((x) => lotKey(x.project, x.lot) !== lotKey(c.lot.project, c.lot.lot));
  const here = [c.lot, ...lots].filter((x) => x.repo === repo || (x.repos ?? []).some((r) => r.path === repo));
  const delivered = new Set<string>();
  for (const { from, to } of moved) {
    if (!isAncestor(repo, to, 'HEAD') || (from !== null && !isAncestor(repo, from, to))) return null;
    const { blocking, unreadable } = blockingLots(here, repo, to);
    if (blocking.length > 0 || unreadable.length > 0) return null;
    for (const x of here) {
      if (x.status !== 'ready') continue;
      try {
        if (gitCommitsIn(x, repo).some((k) => isAncestor(repo, k, to) && (from === null || !isAncestor(repo, k, from)))) delivered.add(lotKey(x.project, x.lot));
      } catch {
        return null;
      }
    }
  }
  return [...delivered];
}

/** Incident du LOT (L133) : la revue a laissé des traces (captures, commit), ni push ni garde supprimée — les lots des autres dépôts continuent. */
function handBack(c: LotCtx, kind: SessionKind, report: unknown, step: StepState, where: string, path: string, b: Snapshot, a: Snapshot, left?: string[]): null {
  const l = c.lot;
  const w = c.wave;
  step.status = 'failed';
  step.cause = `le dépôt${where} a changé pendant une revue`;
  const traces = left ?? [...trackedPaths(a).filter((f) => !trackedPaths(b).includes(f)), ...a.untracked.filter((f) => !b.untracked.includes(f))];
  (w.dirtyRepos ??= new Map()).set(path, lotKey(l.project, l.lot));
  const what = traces.length ? ` (${traces.join(', ')})` : b.head !== a.head ? ' (commit)' : '';
  return stop(c, 'handed-back', `incident : ${kind} de ${lotKey(l.project, l.lot)} a modifié le dépôt${where}${what}${lostVerdict(c, kind, report)}`);
}

/** Décode un chemin de `git status --porcelain` : entre guillemets, avec les échappements du C-quoting (`\303\251`, `\"`, `\\`, `\t`…). */
function unquotePath(f: string): string {
  if (!/^".*"$/s.test(f)) return f;
  const bytes: number[] = [];
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const body = f.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch));
      continue;
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 3;
    } else {
      const n = body[++i];
      bytes.push(...(n in esc ? [esc[n]] : Buffer.from(n)));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Déplace des fichiers non suivis (chemins relatifs au dépôt, décodés) sous `to`, arborescence gardée ; renvoie ceux qui l'ont été (s'arrête au premier échec). */
function moveStray(repo: string, files: string[], to: string): string[] {
  const moved: string[] = [];
  for (const rel of files) {
    try {
      const from = join(repo, rel);
      let dest = join(to, rel);
      for (let i = 1; existsSync(dest); i++) dest = join(to, `${rel}.${i}`);
      mkdirSync(dirname(dest), { recursive: true });
      try {
        renameSync(from, dest);
      } catch {
        copyFileSync(from, dest); // autre volume
        rmSync(from);
      }
      moved.push(rel);
    } catch {
      break;
    }
  }
  return moved;
}

/** Verdict d'une revue interrompue par un incident du lot : rapporté au lead plutôt que perdu (L133). Rien n'est enregistré dans le plan. */
function lostVerdict(c: LotCtx, kind: SessionKind, report: unknown): string {
  if (kind === 'precheck') return '';
  let rep: ReviewReport;
  try {
    rep = checkShape<ReviewReport>(report, REVIEW_SCHEMA);
  } catch {
    return ' ; la revue n\'a pas rendu de verdict exploitable';
  }
  const s = summarize(rep, '');
  const text = `verdict de la revue avant l'incident : ${s.conforme ? 'conforme' : 'non conforme'} (${s.bloquants} bloquant(s), ${s.majeurs} majeur(s), ${s.mineurs} mineur(s)) — « ${s.verdict} » — non enregistré dans le plan, à confirmer par le lead`;
  c.lot.warnings.push(text);
  return ` ; ${text}`;
}

export function badReport(c: LotCtx, step: StepState, e: unknown): null {
  step.status = 'failed';
  step.cause = (e as Error).message;
  return stop(c, 'failed', `${step.kind} : ${(e as Error).message}`);
}


/** Chemins salis d'un dépôt entre deux relevés : suivis modifiés, et fichiers non suivis apparus. */
export const dirtBetween = (before: Snapshot, after: Snapshot): string[] => [...trackedPaths(after), ...after.untracked.filter((f) => !before.untracked.includes(f))];
