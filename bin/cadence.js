#!/usr/bin/env node
import { run } from '../dist/cli.js';

const [tool, ...args] = process.argv.slice(2);
const io = {
  cwd: process.cwd(),
  env: process.env,
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  now: () => new Date(),
};

if (tool === 'run') {
  // cadence 2 (09-11) : une demande, une session Opus, porte, intégration — le bras gagnant du banc (v2/src/run).
  const v2 = await import('../v2/dist/cli.js');
  process.exitCode = await v2.run(['run', ...args], io);
} else if (tool === 'sondes') {
  // Sondes d'interaction (L778) : un script sans dépendance, hors de la table des commandes du plan (ses options lui sont propres).
  const sondes = await import('../scripts/sondes-interaction.mjs');
  process.exitCode = await sondes.main(args, io);
} else if (tool === 'mesures') {
  // Mesures de mise en page (L839, D-34) : le mode script du ux-reviewer, un script sans dépendance comme les sondes.
  const mesures = await import('../scripts/mesures-page.mjs');
  process.exitCode = await mesures.main(args, io);
} else if (tool === 'analyse') {
  // Analyse statique par techno (L801) : un script sans dépendance, comme les sondes ; la porte de cadence run le joue aussi (clé analyse: de cadence.yaml).
  const analyse = await import('../scripts/analyse.mjs');
  process.exitCode = await analyse.main(args, io);
} else if (tool === 'ecriture') {
  // Écriture courte contrôlée (L803, D-31) : un script sans dépendance, comme l'analyse ; il signale les phrases longues, passives ou à point-virgule.
  const ecriture = await import('../scripts/ecriture.mjs');
  process.exitCode = await ecriture.main(args, io);
} else if (tool === 'raf') {
  process.exitCode = await run(args, io);
} else if (['news', 'session', 'deliver', 'verify', 'eval', 'skills', 'orchestrate', 'lead', 'corrections', 'perf', 'cost', 'inspect', 'spec', 'ref', 'config', 'release', 'local', 'claude-hook'].includes(tool)) {
  process.exitCode = await run([tool, ...args], io);
} else if (tool === '--version' || tool === '-v') {
  process.exitCode = await run([tool], io);
} else if (!tool || ['help', '--help', '-h'].includes(tool)) {
  // Une seule aide : celle de src/cli.ts, la même que « raf --help » (L597).
  process.exitCode = await run(['help'], io);
} else {
  io.err(`cadence : outil inconnu : ${tool} (cadence --help)`);
  process.exitCode = 2;
}
