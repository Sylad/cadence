// session start|close|next|context, et leur variante --all (L488, sorti de cli.ts).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readSessionConfig } from '../config.js';
import { parseDeliverConfig } from '../deliver.js';
import { defaultTarget, effectLines, realCheckDeps } from '../verify.js';
import { gitRoot } from '../git.js';
import { RafError } from '../plan.js';
import { closeMemoryLines } from '../memory-index.js';
import { findLeadDir, findProjects, readLeadContextThreshold } from '../lead.js';
import { readHudContext } from '../hud-context.js';
import { sessionClose, type SessionCtx, sessionStart } from '../session.js';
import { clearNext, readNext, sharedStateDir, stateDir, writeNext } from '../state.js';
import { type Ctx, type EarlyCtx, type Io } from './context.js';

/**
 * Reprise : lignes d'effets à rejouer, ou null quand il n'y a rien à vérifier (sans cadence.yaml, sans deliver,
 * script sans verify) — la reprise reste alors synchrone. Ne lève jamais.
 */
function morningEffects(configPath: string, root: string): Promise<string[]> | string[] | null {
  if (!existsSync(configPath)) return null;
  const text = readFileSync(configPath, 'utf8');
  if (!/^deliver\s*:/m.test(text)) return null;
  try {
    const config = parseDeliverConfig(text, configPath);
    if (config.verify.length === 0) return null;
    const target = defaultTarget(root, config);
    return effectLines(config, target.sha, realCheckDeps(root, { quiet: true }), target.note);
  } catch (e) {
    return [`✗ ${(e as Error).message}`];
  }
}

/** `session start|close --all [--depth n]` : la commande jouée dans chaque projet sous le dossier courant, une section par projet. */
async function sessionAll(rest: string[], values: { all?: boolean; depth?: string; since?: string; idle?: string; file?: string; config?: string }, io: Io, run: (argv: string[], io: Io) => number | Promise<number>): Promise<number> {
  const sub = rest[0];
  if (!values.all) throw new RafError('--depth demande --all');
  // Chaque projet lit son propre plan : un plan ou une config imposés se retrouveraient dans toutes les sections.
  const imposed = values.file !== undefined ? '--file' : values.config !== undefined ? '--config' : io.env.RAF_FILE !== undefined ? 'RAF_FILE' : null;
  if (imposed) throw new RafError(`${imposed} ne va pas avec --all : chaque projet lit son propre plan (lancer la commande dans le projet visé)`);
  if (sub !== 'start' && sub !== 'close') throw new RafError('--all ne va qu\'avec session start ou session close');
  const depth = values.depth === undefined ? 1 : Number(values.depth);
  if (!Number.isInteger(depth) || depth < 1) throw new RafError(`--depth invalide : ${values.depth} (un entier ≥ 1)`);
  if (values.idle !== undefined && !(Number.isInteger(Number(values.idle)) && Number(values.idle) >= 0)) throw new RafError(`--idle invalide : ${values.idle}`);
  const projects = findProjects(io.cwd, depth);
  if (projects.length === 0) {
    io.out(`aucun projet sous ${io.cwd} (.cadence/raf.yaml, docs/plan/raf.yaml ou cadence.yaml avec plan:)`);
    return 0;
  }
  const argv = ['session', sub, ...(values.since === undefined ? [] : [`--since=${values.since}`]), ...(values.idle === undefined ? [] : ['--idle', values.idle])];
  let worst = 0;
  for (const dir of projects) {
    io.out(`${dir === projects[0] ? '' : '\n'}## ${relative(io.cwd, dir)}`);
    let code: number;
    const top = gitRoot(dir);
    if (top && realpathSync(top) !== realpathSync(dir)) {
      // run() lirait le plan du dépôt parent : mieux vaut le dire que montrer le plan d'un autre projet.
      io.out(`✗ ${relative(io.cwd, dir)} n'a pas son propre dépôt git (dépôt parent : ${top}) — lancer cadence dans ce dossier`);
      worst = 2;
      continue;
    }
    try {
      code = await run(argv, { ...io, cwd: dir, err: (l) => io.out(`✗ ${l}`), notice: io.notice ?? io.err });
    } catch (e) {
      io.out(`✗ ${e instanceof Error ? e.message : String(e)}`);
      code = 2;
    }
    worst = Math.max(worst, code);
  }
  return worst;
}

/** Le contexte (et sa position par rapport à `lead.contextThreshold`, en tokens) de la session de `--session <id>`, sinon de `CLAUDE_CODE_SESSION_ID`, sinon (variable absente) de la seule session du dossier courant, tel que la bande cadence-hud le publie ; illisible = code 2, à lire comme « au seuil ». */
function sessionContext(io: Io, session?: string): number {
  const r = readHudContext(io.env, io.now().getTime(), { cwd: io.cwd, session });
  if (!r.ok) throw new RafError(`session context : contexte illisible — ${r.reason} ; à traiter comme au seuil`);
  io.out(`ctx ${Math.round(r.ctx.percent)} % (${r.ctx.tokens}/${r.ctx.window})`);
  // Lancée d'un sous-projet, la commande lit le cadence.yaml du dossier du lead (L457) et nomme le dossier lu.
  const leadDir = findLeadDir(io.cwd);
  const threshold = readLeadContextThreshold(leadDir);
  io.out(`seuil ${threshold} tokens : ${r.ctx.tokens >= threshold ? 'atteint' : 'sous le seuil'}${leadDir === io.cwd ? '' : ` (lu dans ${join(leadDir, 'cadence.yaml')})`}`);
  return 0;
}

function session([sub, ...args]: string[], ctx: SessionCtx, values: { since?: string; idle?: string; clear?: boolean }): number {
  switch (sub) {
    case 'start': {
      const idle = values.idle === undefined ? 2 : Number(values.idle);
      if (!Number.isInteger(idle) || idle < 0) throw new RafError(`--idle invalide : ${values.idle}`);
      return sessionStart(ctx, { since: values.since ?? '24 hours ago', idle });
    }
    case 'close':
      return sessionClose(ctx, { since: values.since });
    case 'next': {
      const lines = args.filter((l) => l.trim() !== '');
      if (values.clear) {
        if (lines.length) throw new RafError('session next --clear efface les notes : ne pas lui passer de ligne');
        const gone = clearNext(ctx.state);
        ctx.out(gone ? `notes effacées (${gone.lines.length} ligne(s) du ${gone.date})` : 'aucune note à effacer');
        return 0;
      }
      // Lancée sans ligne (variable vide dans un script, agent pressé), la commande effaçait en silence
      // les notes de la dernière clôture : effacer se demande exprès.
      if (lines.length === 0) {
        const kept = readNext(ctx.state);
        throw new RafError(
          `session next : aucune ligne — ${kept ? `${kept.lines.length} ligne(s) du ${kept.date} conservée(s)` : "rien n'est écrit"} ; ` +
            'usage : cadence session next "ligne" … (pour effacer les notes exprès : cadence session next --clear)',
        );
      }
      writeNext(ctx.state, ctx.today, lines);
      // Rien sur stdout laissait croire à un échec : on redit les lignes telles qu'enregistrées, pour que
      // session-close les rapporte sans relancer session start.
      const n = lines.length;
      ctx.out(`${n} ligne${n > 1 ? 's' : ''} enregistrée${n > 1 ? 's' : ''} pour la prochaine ouverture\n${lines.map((l) => `  - ${l}`).join('\n')}`);
      return 0;
    }
    default:
      throw new RafError('usage : cadence session start [--since …] [--idle 2] | close [--since …] | start|close --all [--depth n] | next "ligne" … | next --clear | context [--session id]');
  }
}

/** cadence session start|close|next|context. */
export function cmdSession(c: Ctx): number | Promise<number> {
  const { rest, values, io, today, root, configPath, loadPlan, newsDir } = c;
  // Le contexte de la session ne dépend d'aucun dépôt : le lead le lit depuis le dossier parent.
  if (rest[0] === 'context') return sessionContext(io, values.session);
  if (!gitRoot(io.cwd)) throw new RafError('session : à lancer dans un dépôt git');
  // « next » n'écrit que les notes : la commande du projet ne se joue qu'à la reprise et à la clôture.
  const sconf = rest[0] === 'start' || rest[0] === 'close' ? readSessionConfig(configPath) : {};
  const facts = rest[0] === 'start' || rest[0] === 'close' ? sconf[rest[0]] : undefined;
  const clean = rest[0] === 'close' && sconf.clean ? { patterns: sconf.clean, days: sconf.cleanDays } : undefined;
  const sctx: SessionCtx = { plan: loadPlan(), root, newsDir, state: stateDir(root), shared: sharedStateDir(root), today, now: io.now(), out: io.out, facts, clean, memory: closeMemoryLines(io.env, io.cwd, configPath) };
  if (rest[0] !== 'start') return session(rest, sctx, values);
  // La reprise rejoue les vérifications d'effet (un essai, borné) : un effet rouge d'hier se lit avec les faits du matin.
  const effects = morningEffects(configPath, root);
  if (effects === null) return session(rest, sctx, values);
  return Promise.resolve(effects).then((lines) => session(rest, { ...sctx, effects: lines }, values));
}

/** `--all` balaie les sous-dossiers : il ne lit ni le plan ni le cadence.yaml du dossier courant ; null sans --all ni --depth. */
export function cmdSessionAll(c: EarlyCtx, run: (argv: string[], io: Io) => number | Promise<number>): number | Promise<number> | null {
  return c.values.all || c.values.depth !== undefined ? sessionAll(c.rest, c.values, c.io, run) : null;
}
