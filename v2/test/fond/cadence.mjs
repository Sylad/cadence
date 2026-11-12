// L709 : le point d'entrée de bin/cadence2.js, sur les sources (avec ts.mjs) : `--fond` relance ce même fichier, détaché.
import { run } from '../../src/cli.js';

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(), env: process.env, now: () => new Date(),
  out: (l) => console.log(l), err: (l) => console.error(l),
});
