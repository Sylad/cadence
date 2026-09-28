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
  process.exitCode = run(args, io);
} else if (tool === 'news') {
  process.exitCode = run(['news', ...args], io);
} else if (tool === '--version' || tool === '-v') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
} else {
  console.log(`cadence — une méthode de travail qui vit dans le dépôt

  cadence raf …     plan « reste à faire » relié aux commits (aussi disponible en « raf »)
  cadence news …    Nouveautés : une entrée avec capture par lot visible, JSON + page autonome

D'autres outils suivront (reprise, clôture, livraison).`);
  process.exitCode = tool ? 2 : 0;
}
