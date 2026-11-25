// L837 : un run laissait des processus vivants après sa fin (vécu le 24-11 : `astro preview --port 4391` d'un run, encore là 26 min après).
// Attendu : à la fin de chaque run (intégré, rendu, échec, interruption), tout ce qu'il a lancé (session, porte, serveurs en arrière-plan) est arrêté, la fin le
// dit, et rien hors du run n'est touché (un autre run en parallèle survit).
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executerRun, repondreRun, type Etat } from '../src/run/run.js';
import { clore } from '../src/run/clore.js';
import { argsPs, arreterGroupe, arreterProcessusDuRun, dansGroupe, MARQUE, processusDuRun, type AvecGroupe } from '../src/processus.js';
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

// Revue L837 du 25-11 : M1 (système sans /proc, macOS), M2 (démons partagés), M3 (--reponse sur un run interrompu).
const SANS_PROC = '/proc-absent-l837';
/** Un id de run neuf pour chaque test (horodatage du test + pid) : ses processus ne se mêlent à rien d'autre. */
const idNeuf = (n: number) => `20991231${String(n).padStart(6, '0')}-${process.pid}`;
const avecMarque = (id: string): NodeJS.ProcessEnv => ({ ...process.env, [MARQUE]: id });

describe('sans /proc : les processus du run sont lus par ps (revue L837, M1)', { timeout: PLAFOND }, () => {
  it('ps (avec l\'environnement) trouve le processus marqué et pas celui d\'un autre run ; la commande affichée ne porte pas l\'environnement ; il est arrêté', () => {
    const id = idNeuf(1), mien = serveur(avecMarque(id), 'sleep 312'), autre = serveur(avecMarque(`${id}0`), 'sleep 313');
    tues.push(mien, autre);
    const vus = processusDuRun(id, { proc: SANS_PROC });
    expect(vus).toEqual([{ pid: mien, commande: 'sleep 312' }]);
    expect(arreterProcessusDuRun(id, { proc: SANS_PROC, graceMs: 2000 })).toEqual({ arretes: [{ pid: mien, commande: 'sleep 312' }], restants: [] });
    expect(vivant(mien)).toBe(false);
    expect(vivant(autre)).toBe(true);
  });

  it('arguments de ps : -axEww sur macOS (son -e n\'affiche pas l\'environnement), axeww sous Linux ; sans l\'environnement pour la commande affichée', () => {
    expect(argsPs('darwin', true)).toEqual(['-axEww', '-o', 'pid=,ppid=,stat=,command=']);
    expect(argsPs('darwin', false)[0]).toBe('-axww');
    expect(argsPs('linux', true)[0]).toBe('axeww');
    expect(argsPs('linux', false)[0]).toBe('axww');
  });

  it('ni /proc ni ps : rien n\'est dit au départ du run, la fin le dit une fois et l\'état le garde', () => {
    const src = { proc: SANS_PROC, ps: () => { throw new Error('ps absent'); } }, l: string[] = [], e: AvecGroupe = { id: idNeuf(2) };
    expect(dansGroupe(e, (x) => l.push(x), () => process.env[MARQUE], src)).toBe(e.id); // le corps joue sous la marque
    expect(l).toEqual([]);
    expect(e.processus).toBeUndefined();
    arreterGroupe(e, (x) => l.push(x), src);
    expect(l).toEqual([`processus du run ${e.id} non contrôlés : ni /proc ni ps lisibles sur ce système (un serveur lancé par la session peut vivre encore)`]);
    expect(e.processus).toEqual({ arretes: [], restants: [], controle: false });
  });

  it('au départ, un run dont rien ne reste ne dit rien (/proc comme ps)', () => {
    for (const src of [{}, { proc: SANS_PROC }]) {
      const l: string[] = [];
      dansGroupe({ id: idNeuf(3) }, (x) => l.push(x), () => 0, src);
      expect(l).toEqual([]);
    }
  });
});

describe('un démon partagé démarré par le run est épargné, avec ce qui en descend (revue L837, M2)', { timeout: PLAFOND }, () => {
  it.each([['/proc', {}], ['ps', { proc: SANS_PROC }]])('lu par %s : le serveur tmux marqué et son panneau survivent, le serveur ordinaire est arrêté ; '
    + 'un panneau marqué sous un tmux sans marque (celui du lead) est arrêté', (_nom, src) => {
    const dir = dossierTemp('l837-demon-'), tmux = join(dir, 'tmux'), panneau = join(dir, 'panneau.pid'), lead = join(dir, 'lead.pid');
    symlinkSync(execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(), tmux); // un « tmux » : bash sous ce nom (comm et commande)
    const id = idNeuf(4);
    const demon = serveur(avecMarque(id), `${tmux} -c 'sleep 314 & echo $! > ${panneau}; wait'`);
    const ordinaire = serveur(avecMarque(id), 'sleep 315');
    // le tmux du lead vit après son panneau (boucle) ; l'id passe par une variable : ps ne distingue pas les arguments de l'environnement
    const tmuxLead = serveur({ ...process.env, [MARQUE]: '', ID_L837: id }, `${tmux} -c 'env ${MARQUE}="$ID_L837" sleep 316 & echo $! > ${lead}; while :; do sleep 1; done'`);
    tues.push(demon, ordinaire, tmuxLead);
    const pidPanneau = execFileSync('bash', ['-c', `for i in $(seq 50); do [ -s ${panneau} ] && [ -s ${lead} ] && break; sleep 0.1; done; cat ${panneau}`], { encoding: 'utf8' });
    const panneauPid = Number(pidPanneau.trim()), leadPid = lirePid(lead);
    tues.push(panneauPid, leadPid);
    const a = arreterProcessusDuRun(id, { ...src, graceMs: 2000 });
    expect(a?.arretes.map((p) => p.pid).sort()).toEqual([ordinaire, leadPid].sort());
    expect([demon, panneauPid, tmuxLead].filter(vivant)).toEqual([demon, panneauPid, tmuxLead]);
    expect([ordinaire, leadPid].filter(vivant)).toEqual([]);
  });
});

describe('--reponse sur un run interrompu arrête ce qu\'il a laissé avant de reprendre la session (revue L837, M3)', { timeout: PLAFOND }, () => {
  it('la session laissée et son serveur sont arrêtés avant la reprise, et le départ le dit ; la reprise finit le run', () => {
    const repo = depot(), l: string[] = [];
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: fauxClaude([commite('autre.txt')]), out: () => {}, attendre: null });
    expect(e.etat).toBe('porte-rouge');
    // le run est tué pendant sa session : en-cours sur disque, sans processus qui le tienne (interrompu, L709) ; sa session et un serveur vivent encore
    writeFileSync(e.fichier, JSON.stringify({ ...JSON.parse(readFileSync(e.fichier, 'utf8')), etat: 'en-cours' } satisfies Partial<Etat>));
    const laisses = [serveur(avecMarque(e.id), 'sleep 317'), serveur(avecMarque(e.id), 'sleep 318', false)];
    tues.push(...laisses);
    const vusALaReprise: number[] = [];
    const r = repondreRun(e.id, repo, 'reprends', { out: (x) => l.push(x), attendre: null, exec: fauxClaude([(cwd) => {
      vusALaReprise.push(...laisses.filter(vivant));
      commite('fait.txt')(cwd);
    }]) });
    expect(vusALaReprise, l.join('\n')).toEqual([]);
    const depart = l.findIndex((x) => x.startsWith(`processus du run ${e.id} arrêtés (2) : `));
    expect(depart, l.join('\n')).toBeGreaterThanOrEqual(0);
    for (const p of laisses) expect(l[depart]).toContain(String(p));
    expect(r.etat, l.join('\n')).toBe('integre');
  });
});
