// L709 : charge les sources TypeScript de v2 sans build, pour un test qui lance cadence dans un vrai processus (node --import ts.mjs) :
// un import relatif « x.js » absent pointe sur « x.ts », dont Node efface les types.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(spec, ctx, suite) {
    if (/^\.\.?\//.test(spec) && spec.endsWith('.js') && ctx.parentURL) {
      const ts = new URL(spec.replace(/\.js$/, '.ts'), ctx.parentURL);
      if (!existsSync(fileURLToPath(new URL(spec, ctx.parentURL))) && existsSync(fileURLToPath(ts))) return suite(ts.href, ctx);
    }
    return suite(spec, ctx);
  },
});
