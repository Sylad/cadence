#!/usr/bin/env node
import { run } from '../dist/cli.js';

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(), env: process.env, now: () => new Date(),
  out: (l) => console.log(l), err: (l) => console.error(l),
});
