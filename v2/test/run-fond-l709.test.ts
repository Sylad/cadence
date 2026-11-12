import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { executerRun, repondreRun, type Etat } from '../src/run/run.js';
import { prendreVerrou, rendreVerrou } from '../src/verrou.js';
import { attendre, commite, depot, etats, fauxClaude, fauxClaudeBin, vivant } from './run-outils.js';
import { dossierTemp } from './temp.js';

// L709 (issue #55 du compte pro) : deux runs --fond morts avec la session Claude Code qui les avait lancés, et rien pour les reprendre.
const FOND = join(import.meta.dirname, 'fond');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ioTest = (cwd: string) => { const sortie: string[] = []; return { cwd, env: {}, now: () => new Date(), out: (l: string) => sortie.push(l), err: (l: string) => sortie.push(l), sortie }; };
describe('cadence run --fond survit à la session qui le lance (L709, issue #55)', () => {
  it('lancé par une « session » dont on tue tout le groupe : le run et sa session vivent, sans lien avec la lanceuse, et le run va au bout', async () => {
    const repo = depot(), trace = dossierTemp('fond-trace-'), bin = fauxClaudeBin(trace);
    // La lanceuse : un shell dans son propre groupe, qui exporte ce qu'une session Claude Code donne à ses commandes, lance le run puis reste ouverte.
    const lanceuse = spawn('bash', ['-c', `export CLAUDE_PID=$$ CLAUDE_CODE_CHILD_SESSION=1 CLAUDE_CODE_MESSAGING_SOCKET=/run/user/0/cc-socks/$$.sock CLAUDE_SSH_CHILD=$$:1 CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1
      "${process.execPath}" --import "${join(FOND, 'ts.mjs')}" "${join(FOND, 'cadence.mjs')}" run "Crée fait.txt" --fond; exec sleep 60`],
    { cwd: repo, detached: true, stdio: 'ignore', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const pidClaude = await attendre(() => (existsSync(join(trace, 'claude.pid')) ? Number(readFileSync(join(trace, 'claude.pid'), 'utf8')) : undefined), 20_000, 'la session du run n\'a pas démarré');
    const e = await attendre(() => etats(repo)[0], 5000, 'aucun état de run');
    const pidRun = Number(JSON.parse(readFileSync(e.fichier.replace(/\.json$/, '.verrou'), 'utf8')).pid);
    expect(e.session).toMatch(UUID); // (3) l'id de session est dans l'état dès le lancement, avant toute réponse de claude
    expect(readFileSync(join(trace, 'args'), 'utf8').split('\n')).toEqual(expect.arrayContaining(['--session-id', e.session]));

    process.kill(-lanceuse.pid!, 'SIGHUP'); process.kill(-lanceuse.pid!, 'SIGKILL'); // la session lanceuse se ferme : tout son groupe meurt
    await new Promise((r) => setTimeout(r, 500));
    expect(vivant(lanceuse.pid!)).toBe(false);
    expect([vivant(pidRun), vivant(pidClaude)]).toEqual([true, true]);
    const env = readFileSync(join(trace, 'env'), 'utf8');
    for (const v of ['CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_SSH_CHILD', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH']) expect(env).not.toMatch(new RegExp(`^${v}=`, 'm'));

    writeFileSync(join(trace, 'go'), '');
    const finale = await attendre(() => { const x = etats(repo)[0]; return x.etat === 'en-cours' ? undefined : x; }, 20_000, 'le run n\'a pas fini');
    expect(finale.etat).toBe('integre');
    await attendre(() => (vivant(pidRun) ? undefined : true), 5000, 'le processus du run ne s\'est pas arrêté');
  });
});

describe('run interrompu (L709, issue #55)', () => {
  /** Un run tué pendant sa première session : l'état écrit au lancement (en-cours, id de session) reste, aucun processus ne tient le verrou. */
  function runInterrompu() {
    const repo = depot(), appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let photo = '';
    const exec = fauxClaude([() => { const d = join(dirname(repo), '.cadence-run'); photo = join(d, readdirSync(d).find((f) => f.endsWith('.json'))!); copyFileSync(photo, `${photo}.vu`); }], appels);
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out: () => {}, attendre: null });
    copyFileSync(`${photo}.vu`, photo);
    return { repo, e, premier: appels[0].args };
  }

  it('--liste dit « interrompu » pour un run en-cours dont le processus est mort, « en-cours » quand un processus vivant le tient', async () => {
    const { repo, e } = runInterrompu();
    expect(JSON.parse(readFileSync(e.fichier, 'utf8')).etat).toBe('en-cours'); // sur disque, rien ne change
    const io = ioTest(repo);
    expect(await cmdRun(['--liste'], io)).toBe(0);
    expect(io.sortie.join('\n')).toMatch(new RegExp(`^${e.id}  interrompu \\(reprendre : cadence run --reponse ${e.id} "reprends"\\)  Crée fait.txt`, 'm'));
    const verrou = e.fichier.replace(/\.json$/, '.verrou');
    expect(prendreVerrou(verrou, 'session')).toBeNull();
    try {
      const io2 = ioTest(repo);
      await cmdRun(['--liste'], io2);
      expect(io2.sortie.join('\n')).toMatch(new RegExp(`^${e.id}  en-cours  `, 'm'));
    } finally { rendreVerrou(verrou); }
  });

  it('--reponse reprend la même session (id écrit au lancement) dans le même worktree, et le run va au bout', () => {
    const { repo, e, premier } = runInterrompu();
    const id = premier[premier.indexOf('--session-id') + 1];
    expect(id).toMatch(UUID);
    expect(premier).not.toContain('--resume');
    const appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let cwd = '';
    const fin = repondreRun(e.id, repo, 'reprends', { exec: (a, o) => { cwd = o.cwd; return fauxClaude([commite('fait.txt')], appels)(a, o); }, out: () => {}, attendre: null });
    expect(appels[0].args).toEqual(expect.arrayContaining(['--resume', id]));
    expect(appels[0].args).not.toContain('--session-id');
    expect(appels[0].args[appels[0].args.indexOf('-p') + 1]).toMatch(/^Ta session a été interrompue[\s\S]*Réponse de Sylvain : reprends$/);
    expect(cwd).toBe(e.worktree);
    expect(fin.etat).toBe('integre');
  });

  it('un run d\'avant L709 (session vide) repris : nouvelle session, sans --resume ni id vide', () => {
    const { repo, e } = runInterrompu();
    writeFileSync(e.fichier, JSON.stringify({ ...JSON.parse(readFileSync(e.fichier, 'utf8')), session: '' }));
    const appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    repondreRun(e.id, repo, 'reprends', { exec: fauxClaude([commite('fait.txt')], appels), out: () => {}, attendre: null });
    expect(appels[0].args).not.toContain('--resume');
    expect(appels[0].args).not.toContain('--session-id');
  });
});
