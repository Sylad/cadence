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

if (tool === 'raf') {
  process.exitCode = await run(args, io);
} else if (['news', 'session', 'deliver', 'verify', 'skills', 'orchestrate', 'lead', 'corrections', 'perf', 'inspect', 'spec', 'ref', 'config', 'release', 'local', 'claude-hook'].includes(tool)) {
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
