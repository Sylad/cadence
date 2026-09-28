#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from '../dist/cli.js';

const [tool, ...args] = process.argv.slice(2);
const io = {
  cwd: process.cwd(),
  env: process.env,
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  now: () => new Date(),
};

if (tool === 'raf') {
  process.exitCode = await run(args, io);
} else if (['news', 'session', 'deliver', 'skills'].includes(tool)) {
  process.exitCode = await run([tool, ...args], io);
} else if (tool === '--version' || tool === '-v') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
} else {
  console.log(`cadence — une méthode de travail qui vit dans le dépôt

  cadence raf …     plan « reste à faire » relié aux commits (aussi disponible en « raf »)
  cadence news …    Nouveautés : une entrée avec capture par lot visible, JSON + page autonome
  cadence session start [--since "24 hours ago"] [--idle 2]
                    faits de reprise : notes de la veille, en cours, fait depuis, écarts, propositions
  cadence session close [--since …]    faits de clôture ; code 1 tant que ce n'est pas fermé
  cadence session next "ligne" …       notes pour la prochaine session (sans argument : efface)
  cadence deliver [--dry-run] [--config cadence.yaml]
                    CI du sha poussé → déploiement → vérifications de l'effet
  cadence skills install [--dir .claude/skills] [--force]
                    installe les skills Claude Code session-start, session-close, deliver`);
  process.exitCode = tool ? 2 : 0;
}
