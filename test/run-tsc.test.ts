import { describe, expect, it } from 'vitest';
import { runCompiler } from './run-tsc.js';

describe('runCompiler', () => {
  it("inclut la sortie stdout du compilateur dans l'erreur levée", () => {
    const script = "console.log('src/x.ts(3,5): error TS2322: bad'); console.error('warn-' + 'err'); process.exit(2)";
    let message = '';
    try {
      runCompiler(process.execPath, ['-e', script], process.cwd());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('src/x.ts(3,5): error TS2322: bad');
    expect(message.split('warn-err')).toHaveLength(2);
  });

  it('ne lève rien quand la commande réussit', () => {
    expect(() => runCompiler(process.execPath, ['-e', '0'], process.cwd())).not.toThrow();
  });
});
