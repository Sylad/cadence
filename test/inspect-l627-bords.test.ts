import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { inspectWave } from '../src/inspect.js';
import { tourInspectLines } from '../src/inspect-read.js';
import { tempDir } from './helpers.js';

const at = (min: number, text: string) => `2026-11-06T09:${String(min).padStart(2, '0')}:00.000Z ${text}`;
const journal = (...lines: string[]) => `${lines.join('\n')}\n`;
const conflit = journal(at(0, 'cadence:L2 → handed-back — intégration impossible : conflit en rebasant a sur b'), at(3, 'cadence:L2 → ready — prêt'));

function runs(waves: Record<string, string>): string {
  const root = tempDir();
  for (const [wave, text] of Object.entries(waves)) {
    mkdirSync(join(root, '.cadence', 'runs', wave), { recursive: true });
    writeFileSync(join(root, '.cadence', 'runs', wave, 'journal.log'), text);
  }
  return root;
}
const go = (root: string, ...argv: string[]) => {
  const out: string[] = [];
  const code = run(argv, { cwd: root, env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-06T12:00:00Z') });
  return { code, out: out.join('\n') };
};

describe('cadence inspect (L627) — bords', () => {
  it('la dernière vague est la plus récente par date, même si un dossier de vague nommé autrement (cadence-l122) a un journal', () => {
    // Forme réelle du dossier .cadence/runs : des vagues AAAA-MM-JJ-HHMM[-suffixe] et des vagues à nom libre.
    const root = runs({ '2026-11-06-0915': conflit, 'cadence-l122': journal(at(0, 'cadence:L1 → implementing')) });
    expect(go(root, 'inspect').out).toContain('inspection de la vague 2026-11-06-0915');
  });

  it('le résumé du tour lit la vague datée la plus récente, pas un dossier à nom libre', () => {
    const root = runs({ '2026-11-05-0900': conflit, '2026-11-06-0915': conflit, 'ol-gains-1': journal(at(0, 'ol:L1 → implementing')) });
    expect(tourInspectLines(root).join('\n')).toContain('inspect 2026-11-06-0915');
  });

  it('un journal vide donne une inspection sans lot ni perte', () => {
    const root = runs({ '2026-11-06-0915': '' });
    const i = inspectWave(join(root, '.cadence', 'runs'), '2026-11-06-0915', []);
    expect(i).toMatchObject({ lots: [], causes: [], totalMinutes: 0, lostMinutes: 0 });
  });
});
