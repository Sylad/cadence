// L837 : un run laissait des processus vivants après sa fin (vécu le 24-11 : `astro preview --port 4391` d'un run, encore là 26 min après).
// Attendu : à la fin de chaque run (intégré, rendu, échec, interruption), tout ce qu'il a lancé (session, porte, serveurs en arrière-plan) est arrêté, la fin le
// dit, et rien hors du run n'est touché (un autre run en parallèle survit).
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executerRun } from '../src/run/run.js';
import { clore } from '../src/run/clore.js';
import { MARQUE, processusDuRun } from '../src/processus.js';
import { attendre, commite, depot, etats, fauxClaude, vivant } from './run-outils.js';
import { dossierTemp } from './temp.js';

const FOND = join(import.meta.dirname, 'fond');
const PLAFOND = 60_000;
const lirePid = (f: string) => Number(readFileSync(f, 'utf8').trim());
/** Lance `commande` en arrière-plan comme le ferait une session (détachée par setsid : hors de tout groupe de processus du run) et rend son pid. */
const serveur = (env: NodeJS.ProcessEnv, commande: string, detache = true) =>
  Number(execFileSync('bash', ['-c', `${detache ? 'setsid ' : 'nohup '}${commande} >/dev/null 2>&1 </dev/null & echo $!`], { env, encoding: 'utf8' }).trim());

const temoins: ChildProcess[] = [], tues: number[] = [];
afterEach(() => { for (const t of temoins.splice(0)) t.kill('SIGKILL'); for (const p of tues.splice(0)) try { process.kill(p, 'SIGKILL'); } catch { /* fini */ } });

describe('un run arrête à sa fin tous les processus qu\'il a lancés (L837)', { timeout: 4 * PLAFOND }, () => {
  it('serveurs de la session (setsid, nohup) et de la porte arrêtés à la fin du run intégré ; un autre run et un processus hors run survivent', () => {
    const traces = dossierTemp('l837-'), pidPorte = join(traces, 'porte.pid');
    const repo = depot(`test -f fait.txt && { setsid sleep 302 >/dev/null 2>&1 </dev/null & echo $! > ${pidPorte}; }`);
    // un autre run en parallèle (sa marque, un autre id) et un processus sans marque : ni l'un ni l'autre n'est du run
    const autre = spawn('sleep', ['303'], { env: { ...process.env, [MARQUE]: '20991231235959-1' }, detached: true, stdio: 'ignore' });
    const libre = spawn('sleep', ['304'], { env: { ...process.env, [MARQUE]: '' }, detached: true, stdio: 'ignore' });
    temoins.push(autre, libre);
    const pids: number[] = [], l: string[] = [];
    const travail = (cwd: string, _a: string[], env: NodeJS.ProcessEnv) => {
      pids.push(serveur(env, 'sleep 300'), serveur(env, 'sleep 301', false));
      commite('fait.txt')(cwd);
    };
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([travail]), out: (x) => l.push(x), attendre: null });
    tues.push(...pids);
    expect(e.etat, l.join('\n')).toBe('integre');
    expect(existsSync(pidPorte), l.join('\n')).toBe(true);
    pids.push(lirePid(pidPorte)); tues.push(lirePid(pidPorte));
    expect(pids.filter(vivant), `encore vivants après la fin du run :\n${l.join('\n')}`).toEqual([]);
    expect(processusDuRun(e.id)).toEqual([]); // aucun processus de son groupe ne vit
    const ligne = l.find((x) => x.startsWith(`processus du run ${e.id} arrêtés (3) : `));
    expect(ligne, l.join('\n')).toBeTruthy();
    for (const p of pids) expect(ligne).toContain(String(p));
    expect(e.processus).toEqual({ arretes: expect.arrayContaining(pids), restants: [] });
    expect(vivant(autre.pid!) && vivant(libre.pid!)).toBe(true);
    expect(vivant(process.pid)).toBe(true);
  });

  it('run rendu (porte rouge) : le serveur de la session est arrêté aussi ; un run qui ne laisse rien ne dit rien', () => {
    const repo = depot(), pids: number[] = [], l: string[] = [];
    const e = executerRun({ repo, demande: 'Travaille', exec: fauxClaude([(cwd, _a, env) => { pids.push(serveur(env, 'sleep 305')); commite('autre.txt')(cwd); }]), out: (x) => l.push(x), attendre: null });
    tues.push(...pids);
    expect(e.etat).toBe('porte-rouge');
    expect(pids.filter(vivant), l.join('\n')).toEqual([]);
    expect(l.some((x) => x.startsWith(`processus du run ${e.id} arrêtés`))).toBe(true);

    const l2: string[] = [];
    const e2 = executerRun({ repo: depot(), demande: 'Crée fait.txt', exec: fauxClaude([commite('fait.txt')]), out: (x) => l2.push(x), attendre: null });
    expect(e2.etat).toBe('integre');
    expect(l2.filter((x) => x.startsWith('processus du run'))).toEqual([]);
    expect(e2.processus).toBeUndefined();
  });

  it('--clore arrête un processus resté au run (session d\'un run tué) ; il ne touche pas un autre run', () => {
    const repo = depot(), l: string[] = [];
    const e = executerRun({ repo, demande: 'Travaille', exec: fauxClaude([commite('autre.txt')]), out: () => {}, attendre: null });
    expect(e.etat).toBe('porte-rouge');
    const reste = spawn('sleep', ['308'], { env: { ...process.env, [MARQUE]: e.id }, detached: true, stdio: 'ignore' });
    const autre = spawn('sleep', ['309'], { env: { ...process.env, [MARQUE]: `${e.id}0` }, detached: true, stdio: 'ignore' });
    temoins.push(reste, autre);
    expect(clore(e, (x) => l.push(x))).toBe(0);
    expect(processusDuRun(e.id), l.join('\n')).toEqual([]); // le fils du test, tué, reste zombie jusqu'à ce que le test le récolte : on lit /proc
    expect(vivant(autre.pid!)).toBe(true);
    expect(l[0]).toBe(`processus du run ${e.id} arrêtés (1) : ${reste.pid} (sleep 308)`);
  });

  it('un processus qui ignore SIGTERM est tué par SIGKILL après la grâce', () => {
    const repo = depot(), pids: number[] = [], l: string[] = [];
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([(cwd, _a, env) => { pids.push(serveur(env, `bash -c "trap '' TERM; sleep 306 & wait"`)); commite('fait.txt')(cwd); }]), out: (x) => l.push(x), attendre: null });
    tues.push(...pids);
    expect(e.etat).toBe('integre');
    expect(pids.filter(vivant), l.join('\n')).toEqual([]);
    expect(processusDuRun(e.id)).toEqual([]);
  });

  it('run --fond interrompu (SIGKILL au run) : le veilleur arrête la session et son serveur, et le journal le dit', async () => {
    const repo = depot(), trace = dossierTemp('l837-fond-'), bin = join(dossierTemp('l837-bin-'), 'claude');
    writeFileSync(bin, `#!/bin/bash
setsid sleep 307 >/dev/null 2>&1 </dev/null & echo $! > "${trace}/serveur.pid"
echo $$ > "${trace}/claude.pid"
for i in $(seq 600); do sleep 0.1; done
`);
    chmodSync(bin, 0o755);
    const r = spawnSync(process.execPath, ['--import', join(FOND, 'ts.mjs'), join(FOND, 'cadence.mjs'), 'run', 'Crée fait.txt', '--fond'],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${dirname(bin)}:${process.env.PATH}` } });
    const journal = /journal : (\S+) ;/.exec(r.stdout)?.[1];
    expect(journal, r.stdout + r.stderr).toBeTruthy();
    const serveurPid = await attendre(() => (existsSync(join(trace, 'serveur.pid')) && existsSync(join(trace, 'claude.pid')) ? lirePid(join(trace, 'serveur.pid')) : undefined), PLAFOND, 'la session n\'a pas démarré');
    const claudePid = lirePid(join(trace, 'claude.pid'));
    tues.push(serveurPid, claudePid);
    const e = await attendre(() => etats(repo)[0], PLAFOND, 'aucun état de run');
    const pidRun = Number(JSON.parse(readFileSync(e.fichier.replace(/\.json$/, '.verrou'), 'utf8')).pid);
    process.kill(pidRun, 'SIGKILL'); // le run meurt sans jouer sa fin
    const lu = () => readFileSync(journal!, 'utf8');
    await attendre(() => (lu().includes(`processus du run ${e.id} arrêtés`) ? true : undefined), PLAFOND, `le veilleur n'a rien arrêté :\n${lu()}`);
    expect([serveurPid, claudePid].filter(vivant), lu()).toEqual([]);
    expect(processusDuRun(e.id)).toEqual([]);
  });
});
