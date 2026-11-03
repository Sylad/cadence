import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const src = join(__dirname, '..', 'src', 'orchestrate');
const files = [
  join(src, 'cycle.ts'),
  ...readdirSync(join(src, 'cycle')).filter((f) => f.endsWith('.ts')).map((f) => join(src, 'cycle', f)),
];

/** Déclarations de premier niveau recollées à la précédente (`}const x`, `}/** … *​/`) : la JSDoc se rattache alors à la mauvaise. */
function glued(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  sf.statements.forEach((st, i) => {
    if (i === 0) return;
    const prev = sf.statements[i - 1]!;
    const between = text.slice(prev.end, st.getStart(sf));
    const firstLine = between.split('\n')[0]!;
    if (!between.includes('\n') || (firstLine.trim() !== '' && !firstLine.trim().startsWith('//'))) {
      const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
      out.push(`${file}:${line}`);
    }
  });
  return out;
}

describe('cycle/ : une déclaration par ligne, JSDoc rattachée (L492)', () => {
  it.each(files)('%s', (file) => {
    expect(glued(file)).toEqual([]);
  });
});
