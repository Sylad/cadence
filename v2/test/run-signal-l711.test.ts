import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { creerExecuteur } from '../src/bench/bras.js';
import { executerRun } from '../src/run/run.js';
import { causeSession } from '../src/trace.js';
import { attendre, depot, etats, fauxClaudeBin, vivant } from './run-outils.js';
import { dossierTemp } from './temp.js';

// L711 (issue #55 du compte pro, commentaire du 12-11) : un run --fond mort à la fin de la session lanceuse sans rien dans son journal. Au prochain cas,
// le journal dit où le run vivait (pid, pgid, sid, ppid, cgroup) et quel signal l'a arrêté, et --liste montre cette cause.
const FOND = join(import.meta.dirname, 'fond');
const ioTest = (cwd: string) => { const sortie: string[] = []; return { cwd, env: {}, now: () => new Date(), out: (l: string) => sortie.push(l), err: (l: string) => sortie.push(l), sortie }; };
const HEURE = '\\(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\)';
// L714 : chaque attente guette un fait observable (ligne du journal, processus mort) ; le plafond, large, ne sert qu'à ne pas pendre si le fait n'arrive
// jamais. Un délai court rougissait le cas du groupe quand la suite complète chargeait la machine (12-11, run de L713).
const PLAFOND = 60_000;
const DUREE_CAS = 4 * PLAFOND;

/** Lance un vrai `cadence run --fond` sur un faux claude qui attend, et rend le journal, le pid du run (son verrou) et celui de claude. */
async function runFond() {
  const repo = depot(), trace = dossierTemp('signal-trace-'), bin = fauxClaudeBin(trace);
  const r = spawnSync(process.execPath, ['--import', join(FOND, 'ts.mjs'), join(FOND, 'cadence.mjs'), 'run', 'Crée fait.txt', '--fond'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const journal = /journal : (\S+) ;/.exec(r.stdout)?.[1];
  expect(journal, r.stdout + r.stderr).toBeTruthy();
  const pidClaude = await attendre(() => (existsSync(join(trace, 'claude.pid')) ? Number(readFileSync(join(trace, 'claude.pid'), 'utf8')) : undefined), PLAFOND, 'la session du run n\'a pas démarré');
  const e = await attendre(() => etats(repo)[0], PLAFOND, 'aucun état de run');
  const pidRun = Number(JSON.parse(readFileSync(e.fichier.replace(/\.json$/, '.verrou'), 'utf8')).pid);
  const lu = () => readFileSync(journal!, 'utf8');
  const finir = async () => { writeFileSync(join(trace, 'go'), ''); await attendre(() => (vivant(pidClaude) ? undefined : true), PLAFOND, 'claude ne s\'est pas arrêté'); };
  return { repo, journal: journal!, e, pidRun, pidClaude, lu, finir };
}

describe('le journal d\'un run --fond dit qui il était et ce qui l\'a arrêté (L711, issue #55)', { timeout: DUREE_CAS }, () => {
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
      const ligne = await attendre(() => lu().split('\n').find((l) => l.includes('SIGTERM')), PLAFOND, `rien sur SIGTERM dans le journal :\n${lu()}`);
      expect(ligne).toMatch(new RegExp(`^cause d'arrêt ${HEURE} : le processus du run \\(pid ${pidRun}\\) a reçu SIGTERM et s'est arrêté \\(code 143\\)$`));
      await attendre(() => (vivant(pidRun) ? undefined : true), PLAFOND, 'le run vit encore');
      await attendre(() => (vivant(ppid) ? undefined : true), PLAFOND, 'le veilleur vit encore après le run');

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
      await attendre(() => (vivant(pidClaude) ? undefined : true), PLAFOND, 'l\'enveloppe n\'a pas arrêté claude (comportement d\'avant)');
      // les trois écrivains (run par son veilleur, enveloppe, veilleur) écrivent chacun à son heure : on attend que le veilleur soit mort, puis chaque ligne
      await attendre(() => (vivant(pgid) ? undefined : true), PLAFOND, 'le veilleur vit encore');
      const ligne = (motif: RegExp) => attendre(() => (motif.test(lu()) ? true : undefined), PLAFOND, `pas de ligne ${motif} :\n${lu()}`);
      await ligne(/le processus du run .* a reçu SIGTERM/);
      await ligne(new RegExp(`^cause d'arrêt ${HEURE} : la session claude \\(enveloppe pid \\d+, claude pid ${pidClaude}\\) a reçu SIGTERM$`, 'm'));
      await ligne(new RegExp(`^cause d'arrêt ${HEURE} : SIGTERM reçu par le groupe du run \\(veilleur pid ${pgid}, run pid ${pidRun}\\)$`, 'm'));
    } finally { await finir(); }
  });

  it('SIGTERM au veilleur seul : il l\'écrit puis s\'arrête comme sans gestionnaire, le run continue', async () => {
    const { pidRun, pidClaude, lu, finir } = await runFond();
    try {
      const veilleur = Number(/ppid (\d+)/.exec(lu())![1]);
      process.kill(veilleur, 'SIGTERM');
      await attendre(() => (vivant(veilleur) ? undefined : true), PLAFOND, `le veilleur a survécu à SIGTERM :\n${lu()}`);
      expect(lu()).toMatch(new RegExp(`^cause d'arrêt ${HEURE} : SIGTERM reçu par le groupe du run \\(veilleur pid ${veilleur}, run pid ${pidRun}\\)$`, 'm'));
      expect([vivant(pidRun), vivant(pidClaude)]).toEqual([true, true]); // il n'arrête rien d'autre que lui
    } finally { await finir(); await attendre(() => (vivant(pidRun) ? undefined : true), PLAFOND, 'le run ne s\'est pas terminé'); }
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

describe('la cause écrite est la vraie : délai, SIGINT, signal exact (L711, suite de revue)', () => {
  const o = { cwd: process.cwd(), env: process.env };
  const tuer = (sig: string) => creerExecuteur('bash')(['-c', `kill -${sig} $PPID; sleep 5`], o); // claude qui signale son enveloppe

  it('délai dépassé : « délai de N h dépassé », pas un SIGTERM venu d\'ailleurs', () => {
    const brut = creerExecuteur('sleep', 1500)(['10'], o);
    expect(brut).toMatchObject({ code: 143, delaiMs: 1500 });
    expect(causeSession(brut)).toMatch(new RegExp(`^cause d'arrêt ${HEURE} : délai de 1.5 s dépassé : le run a arrêté la session claude \\(SIGTERM à son enveloppe, code 143\\)$`));
    expect(causeSession({ code: 143, erreur: 'spawnSync bash ETIMEDOUT', delaiMs: 4 * 3600_000 })).toContain('délai de 4 h dépassé');
  });

  it('SIGINT à l\'enveloppe : SIGINT (code 130), plus SIGTERM', () => {
    const brut = tuer('INT');
    expect(brut.code).toBe(130);
    expect(causeSession(brut)).toMatch(/: la session claude s'est arrêtée sur SIGINT \(code 130\)$/);
  });

  it('un autre signal : le signal exact', () => {
    expect(causeSession(tuer('TERM'))).toMatch(/: la session claude s'est arrêtée sur SIGTERM \(code 143\)$/);
    expect(causeSession(tuer('HUP'))).toMatch(/: l'enveloppe de la session claude a été tuée par SIGHUP$/);
  });
});
