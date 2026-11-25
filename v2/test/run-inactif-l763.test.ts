// L763 (issue #63 du compte pro) : une session de cadence run (claude -p, sans interface) qui lance une commande avec run_in_background n'est jamais
// réveillée par sa fin : elle attend sans fin (deux runs bloqués le 17-11, 21 et 55 min). (1) Un hook PreToolUse refuse ce lancement dans les réglages du
// run ; (2) cadence run --liste signale une session vivante sans commande en cours ni écriture depuis N minutes, avec la commande de reprise.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { executerRun, type Etat } from '../src/run/run.js';
import { noteBloquee, sessionBloquee, type Proc } from '../src/inactif.js';
import { HOOKS, PORTE_MS } from '../src/socle.js';
import { debutProcessus } from '../src/verrou.js';
import { attendre, commite, depot, fauxClaude } from './run-outils.js';
import { dossierTemp } from './temp.js';

const HOOK = join(HOOKS, 'premier-plan.mjs');
const jouerHook = (commande: string, entree: unknown, env: NodeJS.ProcessEnv = {}) =>
  spawnSync('bash', ['-c', commande], { input: typeof entree === 'string' ? entree : JSON.stringify(entree), encoding: 'utf8', env: { ...process.env, ...env } });
const bash = (input: Record<string, unknown>) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npx vitest run', ...input } });
type Reglages = { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }; env: Record<string, string> };
const reglagesLus = (args: string[]) => JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')) as Reglages;

describe('L763 (1) : le hook refuse run_in_background dans une session de cadence run', () => {
  it('Bash avec run_in_background : refus (code 2) et message qui dit de jouer au premier plan, timeout à la hauteur de la commande, porte comprise', () => {
    const r = jouerHook(`node "${HOOK}"`, bash({ run_in_background: true, timeout: 600000 }), { BASH_MAX_TIMEOUT_MS: String(PORTE_MS) });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/au premier plan, sans run_in_background, avec un timeout en millisecondes à la hauteur/);
    expect(r.stderr).toMatch(/porte du dépôt comprise/);
    expect(r.stderr).toContain(`jusqu'à ${PORTE_MS} ms`);
    expect(r.stderr).toContain('issue #63');
  });

  it('laisse passer : Bash au premier plan, run_in_background à false, un autre outil, une entrée illisible', () => {
    for (const e of [bash({}), bash({ run_in_background: false }), { tool_name: 'Read', tool_input: { file_path: '/x', run_in_background: true } }, 'pas du json'])
      expect(jouerHook(`node "${HOOK}"`, e).status).toBe(0);
  });

  describe('dans les réglages de chaque session du run', () => {
    const avant = process.env.CLAUDE_CONFIG_DIR;
    beforeEach(() => { process.env.CLAUDE_CONFIG_DIR = dossierTemp('claude-home-'); });
    afterEach(() => { if (avant === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = avant; });

    it('mode léger : le hook sur Bash et BASH_MAX_TIMEOUT_MS à la durée d\'une commande de la porte ; la commande posée refuse vraiment', () => {
      let r: Reglages | undefined;
      const e = executerRun({ repo: depot(), demande: 'Crée fait.txt', exec: fauxClaude([(cwd, a) => { r = reglagesLus(a); commite('fait.txt')(cwd); }]), out: () => {} });
      expect(e.etat).toBe('integre');
      expect(r!.env).toEqual({ BASH_MAX_TIMEOUT_MS: String(PORTE_MS) });
      expect(r!.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${HOOK}"`, timeout: 10 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${join(HOOKS, 'cadence-permise.mjs')}"`, timeout: 10 }] }]); // L840
      const commande = r!.hooks.PreToolUse[0].hooks[0].command;
      expect(jouerHook(commande, bash({ run_in_background: true }), r!.env).status).toBe(2);
      expect(jouerHook(commande, bash({})).status).toBe(0);
    });

    it('mode complet : le hook de lecture du bras reste (chemin des hooks résolu), le refus s\'y ajoute', () => {
      let r: Reglages | undefined;
      const e = executerRun({ repo: depot(), demande: 'Crée fait.txt', complet: true, exec: fauxClaude([(cwd, a) => { r = reglagesLus(a); commite('fait.txt')(cwd); }]), out: () => {} });
      expect(e.etat).toBe('integre');
      const commandes = r!.hooks.PreToolUse.map((h) => h.hooks[0].command);
      expect(commandes).toEqual([`node "${join(HOOKS, 'lecture-obligatoire.mjs')}" || exit 2`, `node "${HOOK}"`, `node "${join(HOOKS, 'cadence-permise.mjs')}"`]); // L840
      expect(JSON.stringify(r)).not.toContain('{{HOOKS}}');
    });
  });
});

describe('L763 (2) : une session vivante sans commande en cours ni sortie depuis N minutes', () => {
  const SESSION = '4242424242';
  const MAINTENANT = Date.parse('2026-11-17T12:00:00Z');
  /** Le transcript de la session dans un CLAUDE_CONFIG_DIR jetable, écrit il y a `minutes`. */
  function transcript(worktree: string, minutes: number, session = SESSION): NodeJS.ProcessEnv {
    const home = dossierTemp('claude-home-'), d = join(home, 'projects', worktree.replace(/[^A-Za-z0-9]/g, '-')), f = join(d, `${session}.jsonl`);
    mkdirSync(d, { recursive: true }); writeFileSync(f, '{}\n');
    const t = new Date(MAINTENANT - minutes * 60_000); utimesSync(f, t, t);
    return { CLAUDE_CONFIG_DIR: home };
  }
  // Le run (pid 100) → l'enveloppe bash (101) → claude (102) → un serveur MCP (103, node) ; `plus` : d'autres processus.
  const arbre = (...plus: Proc[]): Proc[] => [
    { pid: 100, ppid: 1, comm: 'node', cmdline: 'node cadence2.js run Crée fait.txt' },
    { pid: 101, ppid: 100, comm: 'bash', cmdline: `bash -c … claude -p … --session-id ${SESSION}` },
    { pid: 102, ppid: 101, comm: 'claude', cmdline: `claude -p … --session-id ${SESSION}` },
    { pid: 103, ppid: 102, comm: 'npm exec @playwright/mcp', cmdline: 'npm exec @playwright/mcp' }, ...plus];
  const run = (worktree: string) => ({ id: 'r1', session: SESSION, worktree, fichier: join(dossierTemp('etat-'), 'x.json') });

  it('signalée : claude vivant, aucun shell enfant, transcript muet depuis 30 min ; la note donne le pid de claude et la commande de reprise', () => {
    const wt = '/tmp/projet-r1', env = transcript(wt, 30);
    expect(sessionBloquee(run(wt), 100, { seuilMin: 15, maintenant: MAINTENANT, procs: arbre(), env })).toEqual({ claude: 102, depuis: MAINTENANT - 30 * 60_000, minutes: 30 });
    expect(noteBloquee(run(wt), 100, { seuilMin: 15, maintenant: MAINTENANT, procs: arbre(), env }))
      .toBe('session bloquée ? aucune commande en cours et rien d\'écrit depuis 30 min (seuil 15 min) ; reprendre : kill 102 (la session claude), puis cadence run --reponse r1 "reprends"');
  });

  it('pas signalée : une commande tourne (shell enfant de claude), transcript récent, seuil plus haut, pas de claude (porte, intégration), run mort', () => {
    const wt = '/tmp/projet-r1', o = { seuilMin: 15, maintenant: MAINTENANT, env: transcript(wt, 30) };
    expect(sessionBloquee(run(wt), 100, { ...o, procs: arbre({ pid: 104, ppid: 102, comm: 'bash', cmdline: 'bash -c npx vitest run' }) })).toBeNull();
    expect(sessionBloquee(run(wt), 100, { ...o, procs: arbre(), env: transcript(wt, 5) })).toBeNull();
    expect(sessionBloquee(run(wt), 100, { ...o, procs: arbre(), seuilMin: 45 })).toBeNull();
    const porte: Proc[] = [arbre()[0], { pid: 110, ppid: 100, comm: 'bash', cmdline: 'bash -c npx vitest run' }];
    expect(sessionBloquee(run(wt), 100, { ...o, procs: porte })).toBeNull();
    expect(sessionBloquee(run(wt), undefined, { ...o, procs: arbre() })).toBeNull();
    expect(noteBloquee(run(wt), 100, { ...o, procs: arbre(), seuilMin: 45 })).toBe('');
  });

  it('un sous-agent qui écrit compte comme une sortie ; sans transcript, l\'heure de l\'état du run (écrit au départ de la session)', () => {
    const wt = '/tmp/projet-r1', env = transcript(wt, 30), d = join(env.CLAUDE_CONFIG_DIR!, 'projects', wt.replace(/[^A-Za-z0-9]/g, '-'), SESSION, 'subagents');
    mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'agent-1.jsonl'), '{}\n');
    const t = new Date(MAINTENANT - 2 * 60_000); utimesSync(join(d, 'agent-1.jsonl'), t, t);
    expect(sessionBloquee(run(wt), 100, { seuilMin: 15, maintenant: MAINTENANT, procs: arbre(), env })).toBeNull();
    const r = run('/tmp/sans-transcript'); writeFileSync(r.fichier, '{}'); const vieux = new Date(MAINTENANT - 40 * 60_000); utimesSync(r.fichier, vieux, vieux);
    expect(sessionBloquee(r, 100, { seuilMin: 15, maintenant: MAINTENANT, procs: arbre(), env: { CLAUDE_CONFIG_DIR: dossierTemp('vide-') } })?.minutes).toBe(40);
  });

  describe('cadence run --liste, sur de vrais processus', () => {
    const tues: number[] = [];
    afterAll(() => { for (const p of tues) try { process.kill(p, 'SIGKILL'); } catch { /* déjà mort */ } });
    const ioTest = (cwd: string, env: NodeJS.ProcessEnv) => { const sortie: string[] = []; return { cwd, env, now: () => new Date(), out: (l: string) => sortie.push(l), err: (l: string) => sortie.push(l), sortie }; };

    /** Un run en-cours tenu par un processus vivant (le « run », un bash) dont l'enfant porte l'id de session (la « session claude », un sleep sans enfant). */
    async function runVivant(minutes: number) {
      const repo = depot();
      let photo = '';
      const e = executerRun({ repo, demande: 'Crée fait.txt', out: () => {}, attendre: null, exec: fauxClaude([() => {
        const d = join(dirname(repo), '.cadence-run'); photo = join(d, readdirSync(d).find((f) => f.endsWith('.json'))!); copyFileSync(photo, `${photo}.vu`); }]) });
      copyFileSync(`${photo}.vu`, photo);
      const etat = { ...(JSON.parse(readFileSync(photo, 'utf8')) as Etat), session: SESSION }; writeFileSync(photo, JSON.stringify(etat));
      const p = spawn('bash', ['-c', `sleep 3600 ${SESSION}; true`], { stdio: 'ignore' }); tues.push(p.pid!);
      const claude = await attendre(() => { const x = spawnSync('pgrep', ['-P', String(p.pid)], { encoding: 'utf8' }).stdout.trim(); return x ? Number(x) : undefined; }, 5000, 'pas de sleep');
      tues.push(claude);
      writeFileSync(e.fichier.replace(/\.json$/, '.verrou'), JSON.stringify({ pid: p.pid, start: debutProcessus(p.pid!), role: 'session', depuis: new Date().toISOString() }));
      const env = transcript(etat.worktree, 0), f = join(env.CLAUDE_CONFIG_DIR!, 'projects', etat.worktree.replace(/[^A-Za-z0-9]/g, '-'), `${SESSION}.jsonl`);
      const t = new Date(Date.now() - minutes * 60_000); utimesSync(f, t, t);
      return { repo, e, claude, env };
    }

    it('signale la session muette avec le pid de claude et la commande de reprise ; --inactif relève le seuil', async () => {
      const { repo, e, claude, env } = await runVivant(25);
      const io = ioTest(repo, env);
      expect(await cmdRun(['--liste'], io)).toBe(0);
      expect(io.sortie.join('\n')).toMatch(new RegExp(`^${e.id}  en-cours  Crée fait.txt  · session bloquée \\? aucune commande en cours et rien d'écrit depuis 25 min \\(seuil 15 min\\) ; `
        + `reprendre : kill ${claude} \\(la session claude\\), puis cadence run --reponse ${e.id} "reprends"$`, 'm'));
      const io2 = ioTest(repo, env);
      expect(await cmdRun(['--liste', '--inactif', '30'], io2)).toBe(0);
      expect(io2.sortie.join('\n')).toMatch(new RegExp(`^${e.id}  en-cours  Crée fait.txt$`, 'm'));
    });

    it('--inactif mal donné : usage, code 2', async () => {
      for (const a of [['--liste', '--inactif'], ['--liste', '--inactif', '0'], ['--liste', '--inactif', 'x'], ['--liste', 'autre']]) {
        const io = ioTest(dossierTemp('vide-'), {});
        expect(await cmdRun(a, io)).toBe(2);
        expect(io.sortie).toEqual(['usage : cadence run --liste [--inactif <minutes>]']);
      }
    });
  });
});
