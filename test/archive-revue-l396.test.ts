import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, type YAMLSeq } from 'yaml';
import { Plan } from '../src/plan.js';
import { repoWithPlan } from './archive-helpers.js';

/** `plan.onWrite` du dépôt : `command` lancé après chaque écriture du plan. */
const onWrite = (dir: string, command: string) => writeFileSync(join(dir, 'cadence.yaml'), `plan:\n  path: .cadence/raf.yaml\n  onWrite:\n    command: '${command}'\n`);

describe('L396 — revue de code, constat 1 : archivage sans perte', () => {
  it("R17 — plan.onWrite en échec pendant raf archive : rien ne reste dans l'archive, et le rejeu après correction emporte la note ajoutée entre-temps", async () => {
    const r = repoWithPlan();
    onWrite(r.dir, 'exit 2');
    const failed = await r.raf('archive');
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain('plan.onWrite en échec');
    expect(Plan.load(r.plan).lots().map((l) => l.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    // « plan inchangé » doit être vrai de l'archive aussi : aucune copie de L1 n'y attend.
    expect(existsSync(join(r.dir, '.cadence/archive'))).toBe(false);

    onWrite(r.dir, 'true');
    expect((await r.raf('note', 'L1', 'décision importante')).code).toBe(0);
    const again = await r.raf('archive');
    expect(again.code).toBe(0);
    expect(again.out).toContain('L1');
    const text = readFileSync(r.archive('2025'), 'utf8');
    expect(text.match(/id: L1/g)).toHaveLength(1);
    expect(text).toContain('décision importante');
    expect((await r.raf('show', 'L1', '--notes')).out).toContain('décision importante');
  });

  it('R18 — un lot archivé remis à la main dans le plan puis modifié : le réarchivage remplace la copie archivée, sans doublon ni perte', async () => {
    const r = repoWithPlan();
    await r.raf('archive', '--before', '2026-01-01');
    const archived = parseDocument(readFileSync(r.archive('2025'), 'utf8'));
    const plan = parseDocument(readFileSync(r.plan, 'utf8'));
    (plan.get('lots') as YAMLSeq).add((archived.get('lots') as YAMLSeq).items[0]);
    writeFileSync(r.plan, plan.toString({ lineWidth: 0 }));
    expect(Plan.load(r.plan).lots().map((l) => l.id)).toContain('L1');
    expect((await r.raf('note', 'L1', 'reprise après coup')).code).toBe(0);

    const res = await r.raf('archive', '--before', '2026-01-01');
    expect(res.code).toBe(0);
    expect(Plan.load(r.plan).lots().map((l) => l.id)).toEqual(['L2', 'L3', 'L4', 'L5']);
    const text = readFileSync(r.archive('2025'), 'utf8');
    expect(text.match(/id: L1/g)).toHaveLength(1);
    expect(text).toContain('reprise après coup');
    expect((await r.raf('show', 'L1', '--notes')).out).toContain('reprise après coup');
  });
});
