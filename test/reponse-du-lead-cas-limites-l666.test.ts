import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { answeredText } from '../src/orchestrate/spec.js';
import { claudeOut, commitFile, harness, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';

// L666 : le contrat de réponse du lead — cas limites listés par le precheck, réponse du lead devenue règle avec ses cas limites, avant la spec.
const root = join(__dirname, '..');
const plat = (f: string) => readFileSync(join(root, f), 'utf8').replace(/\s+/g, ' ');

const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut({ bloquants: 0, majeurs: 0, mineurs: 0, constats: [], sousTaches: [], nonVerifie: [], verdict: 'conforme' } as never);
const specBrief = async (lu: string | undefined): Promise<string> => {
  const h = harness({ lots: [{ title: 'Un écran', screen: 'page' as const }], script: { spec: [spec], maquette: [ok], implement: [impl], ux: [ok], review: [ok] } });
  const c = h.lot('L1', { visible: true, screen: 'page' as const }, { maquette: true, ux: { url: 'http://localhost:4200' } });
  c.lot.precheckLu = lu;
  await runLot(c);
  return h.calls.find((k) => k.kind === 'spec')!.brief;
};

describe('L666 — cas limites de la règle et réponse du lead', () => {
  it('R1 — precheck.md demande, dans `lu`, les cas limites de la règle du lot (base absente, copie sans perte côté source)', () => {
    const t = plat('templates/orchestrate/precheck.md');
    expect(t).toMatch(/edge cases of the rule/i);
    expect(t).toContain('absent base');
    expect(t).toContain('lossless copy on the source side');
  });
  it('R2 — la lecture du precheck (cas limites compris) arrive dans le brief de la spec', async () => {
    expect(await specBrief('Edge cases of the rule: LECTURE-L666')).toContain('LECTURE-L666');
  });
  it('R2 — le brief de la spec ne porte pas la consigne d\'implémentation (modifier, relire les lignes éditées)', async () => {
    const b = await specBrief('Edge cases of the rule: LECTURE-L666');
    expect(b).toContain('Pre-check reading');
    expect(b).not.toContain('reopen a file only to modify it');
  });
  it('R2 — sans lecture du precheck, le brief de la spec n\'en porte pas l\'en-tête', async () => {
    expect(await specBrief(undefined)).not.toContain('Pre-check reading');
  });
  it('R3 — la réponse du lead à une question de contrat devient une règle avec ses cas limites, règle déjà sourcée ou non', () => {
    for (const sourced of [[], ['R3']]) {
      const t = answeredText(['R3 : d\'où vient le contenu ?'], 'le contenu vient de cette source', sourced).replace(/\s+/g, ' ');
      expect(t, sourced.join()).toMatch(/edge cases of the answer/);
      expect(t, sourced.join()).toMatch(/its own rule[^.]*`si_faux`/);
    }
  });
  it('R4 — spec.md et spec-back.md posent la règle : une réponse du lead à une question de contrat est une règle avant la fiche', () => {
    for (const f of ['templates/orchestrate/spec.md', 'templates/orchestrate/spec-back.md']) {
      const t = plat(f);
      expect(t, f).toMatch(/answer of the lead to a contract question is a rule/);
      expect(t, f).toMatch(/absent base/);
    }
  });
  it('R5 — docs/orchestrate-spec.md et le CHANGELOG décrivent le contrat (L666)', () => {
    expect(plat('docs/orchestrate-spec.md')).toContain('L666');
    expect(plat('CHANGELOG.md')).toContain('L666');
  });
});
