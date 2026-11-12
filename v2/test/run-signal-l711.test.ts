import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { executerRun } from '../src/run/run.js';
import { attendre, depot, etats, fauxClaudeBin, vivant } from './run-outils.js';
import { dossierTemp } from './temp.js';

// L711 (issue #55 du compte pro, commentaire du 12-11) : un run --fond mort à la fin de la session lanceuse sans rien dans son journal. Au prochain cas,
// le journal dit où le run vivait (pid, pgid, sid, ppid, cgroup) et quel signal l'a arrêté, et --liste montre cette cause.
const FOND = join(import.meta.dirname, 'fond');
const ioTest = (cwd: string) => { const sortie: string[] = []; return { cwd, env: {}, now: () => new Date(), out: (l: string) => sortie.push(l), err: (l: string) => sortie.push(l), sortie }; };
const HEURE = '\\(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\)';

/** Lance un vrai `cadence run --fond` sur un faux claude qui attend, et rend le journal, le pid du run (son verrou) et celui de claude. */
async function runFond() {
  const repo = depot(), trace = dossierTemp('signal-trace-'), bin = fauxClaudeBin(trace);
  const r = spawnSync(process.execPath, ['--import', join(FOND, 'ts.mjs'), join(FOND, 'cadence.mjs'), 'run', 'Crée fait.txt', '--fond'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const journal = /journal : (\S+) ;/.exec(r.stdout)?.[1];
  expect(journal, r.stdout + r.stderr).toBeTruthy();
  const pidClaude = await attendre(() => (existsSync(join(trace, 'claude.pid')) ? Number(readFileSync(join(trace, 'claude.pid'), 'utf8')) : undefined), 20_000, 'la session du run n\'a pas démarré');
  const e = await attendre(() => etats(repo)[0], 5000, 'aucun état de run');
  const pidRun = Number(JSON.parse(readFileSync(e.fichier.replace(/\.json$/, '.verrou'), 'utf8')).pid);
  const lu = () => readFileSync(journal!, 'utf8');
  const finir = async () => { writeFileSync(join(trace, 'go'), ''); await attendre(() => (vivant(pidClaude) ? undefined : true), 10_000, 'claude ne s\'est pas arrêté'); };
  return { repo, journal: journal!, e, pidRun, pidClaude, lu, finir };
}

describe('le journal d\'un run --fond dit qui il était et ce qui l\'a arrêté (L711, issue #55)', () => {
  it('un run factice reçoit SIGTERM : le journal le dit avec l\'heure, l\'arrêt est celui d\'avant, --liste affiche la cause', async () => {
    const { repo, journal, e, pidRun, lu, finir } = await runFond();
    try {
      expect(e.journal).toBe(journal); // le run sait son journal : --liste le relit
      // (1) au lancement : pid, pgid, sid, ppid et cgroup du processus du run (Linux : /proc existe)
      const id = new RegExp(`^processus du run ${HEURE} : pid ${pidRun}, pgid (\\d+), sid (\\d+), ppid (\\d+), cgroup \\S`, 'm').exec(lu());
      expect(id, lu()).not.toBeNull();
      const [pgid, sid, ppid] = id!.slice(1).map(Number);
      expect([pgid, sid]).toEqual([ppid, ppid]); // le veilleur, détaché (setsid), est le parent du run et le chef de son groupe et de sa session

      process.kill(pidRun, 'SIGTERM'); // le run seul, comme un kill <pid> du verrou
      const ligne = await attendre(() => lu().split('\n').find((l) => l.includes('SIGTERM')), 5000, `rien sur SIGTERM dans le journal :\n${lu()}`);
      expect(ligne).toMatch(new RegExp(`^cause d'arrêt ${HEURE} : le processus du run \\(pid ${pidRun}\\) a reçu SIGTERM et s'est arrêté \\(code 143\\)$`));
      await attendre(() => (vivant(pidRun) ? undefined : true), 5000, 'le run vit encore');
      await attendre(() => (vivant(ppid) ? undefined : true), 5000, 'le veilleur vit encore après le run');

      const io = ioTest(repo);
      expect(await cmdRun(['--liste'], io)).toBe(0);
      expect(io.sortie.join('\n')).toContain(`${e.id}  interrompu (reprendre : cadence run --reponse ${e.id} "reprends")  Crée fait.txt  · ${ligne}`);
    } finally { await finir(); }
  });

  it('SIGTERM au groupe du run : l\'enveloppe de la session claude et le veilleur l\'écrivent, la session s\'arrête comme avant', async () => {
    const { pidRun, pidClaude, lu, finir } = await runFond();
    try {
      const pgid = Number(/pgid (\d+)/.exec(lu())![1]);
      process.kill(-pgid, 'SIGTERM');
      await attendre(() => (vivant(pidClaude) ? undefined : true), 5000, 'l\'enveloppe n\'a pas arrêté claude (comportement d\'avant)');
      await attendre(() => (/le processus du run .* a reçu SIGTERM/.test(lu()) ? true : undefined), 5000, `pas de ligne du run :\n${lu()}`);
      expect(lu()).toMatch(new RegExp(`^cause d'arrêt ${HEURE} : la session claude \\(enveloppe pid \\d+, claude pid ${pidClaude}\\) a reçu SIGTERM$`, 'm'));
      expect(lu()).toMatch(new RegExp(`^cause d'arrêt ${HEURE} : SIGTERM reçu par le groupe du run \\(veilleur pid ${pgid}, run pid ${pidRun}\\)$`, 'm'));
    } finally { await finir(); }
  });
});

describe('une session claude arrêtée par un signal (L711)', () => {
  const jouer = (brut: { stdout: string; code: number; erreur?: string }) => {
    const sortie: string[] = [];
    const e = executerRun({ repo: depot(), demande: 'Crée fait.txt', exec: () => brut, out: (l) => sortie.push(l), attendre: null });
    return { e, sortie: sortie.join('\n') };
  };

  it('claude mort sur un signal (code 128 + n) : le run écrit le signal et le code, puis finit en échec comme avant', () => {
    const { e, sortie } = jouer({ stdout: '', code: 137 });
    expect(sortie).toMatch(new RegExp(`^cause d'arrêt ${HEURE} : la session claude s'est arrêtée sur SIGKILL \\(code 137\\)$`, 'm'));
    expect(e.etat).toBe('echec');
  });

  it('l\'enveloppe elle-même tuée (signal rendu par spawnSync) : le run le dit ; une fin ordinaire n\'écrit aucune cause', () => {
    expect(jouer({ stdout: '', code: 1, erreur: 'SIGHUP' }).sortie).toMatch(/^cause d'arrêt \(.*\) : l'enveloppe de la session claude a été tuée par SIGHUP$/m);
    expect(jouer({ stdout: '', code: 1 }).sortie).not.toContain('cause d\'arrêt');
  });
});
