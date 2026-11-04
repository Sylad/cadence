import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, probeReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const root = join(import.meta.dirname, '..');
const brief = () => readFileSync(join(root, 'templates/orchestrate/probe.md'), 'utf8');
const impl = (...files: string[]): Handler => (call) => claudeOut(workReport({ commits: files.map((f) => commitFile(call.opts.cwd, f, `feat(L1): ${f}`)) }));
const probe = (over: Record<string, unknown> = {}): Handler => (call) => claudeOut(probeReport({ commits: [commitFile(call.opts.cwd, 'p.spec.ts', 'probe(L1): p.spec.ts')], ...over }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const HORS = 'p.spec.ts > nom vide > rejette — le serveur refuse déjà ce nom — refus attendu';

describe("la sonde ne commite ni fichier rouge ni fichier hors porte (L580, issue #37)", () => {
  it("R1 — le brief exige un fichier joué par la porte du projet et vert au dernier commit du lot, sinon pas commité", () => {
    const text = brief();
    expect(text).toMatch(/played by the project's gate/i);
    expect(text).toMatch(/green at the lot's last commit/i);
    expect(text).toMatch(/otherwise do not commit it/i);
  });

  it("R2 — le brief range en « horsRegle » les attentes qui ne sont pas des règles du lot, sans les commiter", () => {
    const text = brief();
    expect(text).toContain('horsRegle');
    expect(text).toMatch(/not a rule of the lot/i);
    expect(text).not.toMatch(/commit them all, the ones that pass and the ones that fail/i);
  });

  it("R3 — le brief demande que le fichier respecte les linters du dépôt (shellcheck compris)", () => {
    const text = brief();
    expect(text).toMatch(/linters? of the repository/i);
    expect(text).toContain('shellcheck');
  });

  it("R4 — les entrées « horsRegle » du rapport deviennent un warning chacune et n'envoient pas le lot en correction", async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [probe({ horsRegle: [HORS, '  ', 'autre borne — attendu'] })], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.warnings).toContain(`sonde de cas limites : attente hors règle du lot, non commitée (à reprendre en constat de revue ou en sous-tâche) : ${HORS}`);
    expect(c.lot.warnings.filter((w) => w.includes('hors règle du lot'))).toHaveLength(2);
    expect(git(h.repo, 'log', '--format=%s')).toContain('probe(L1): p.spec.ts');
  });

  it("R4 — champ absent, vide ou mal typé : aucun warning, la revue part", async () => {
    for (const bad of [undefined, [], 'une chaîne', { a: 1 }, [3, null]]) {
      const h = harness({ script: { implement: [impl('a.ts')], probe: [probe(bad === undefined ? {} : { horsRegle: bad })], review: [ok] } });
      const c = h.lot('L1', {}, { probe: true });
      await runLot(c);
      expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
      expect(c.lot.warnings.join('\n')).not.toContain('hors règle du lot');
    }
  });

  it("R4 — la documentation de l'étape décrit « horsRegle »", () => {
    expect(readFileSync(join(root, 'docs/orchestrate.md'), 'utf8')).toContain('horsRegle');
  });
});

describe("un fichier de sonde non commité ne reste pas dans le dépôt (L580, issue #37, correction)", () => {
  const leaves = (file: string, over: Record<string, unknown> = {}): Handler => (call) => {
    writeFileSync(join(call.opts.cwd, file), "it('hors règle', () => {});\n");
    return claudeOut(probeReport(over));
  };

  it("R5 — le brief demande d'effacer le fichier qu'il ne commite pas, l'arbre de travail ne garde que les fichiers commités", () => {
    const text = brief();
    expect(text).toMatch(/otherwise do not commit it: delete it/i);
    expect(text).toMatch(/not committed, red or skipped, and (its file is )?deleted/i);
  });

  it("R6 — une sonde qui répond et laisse un fichier NON SUIVI : le fichier est retiré, un warning le nomme, la revue part", async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [leaves('hors.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(existsSync(join(h.repo, 'hors.spec.ts'))).toBe(false);
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
    expect(c.lot.warnings).toContain('sonde de cas limites : fichiers non commités laissés par la session retirés (hors.spec.ts)');
  });

  it("R6 — le fichier non suivi laissé avec des attentes horsRegle : les warnings et la sous-tâche proposée sont gardés", async () => {
    const h = harness({ script: { implement: [impl('a.ts')], probe: [leaves('hors.spec.ts', { horsRegle: ['hors.spec.ts — nom vide — refus'] })], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.warnings).toContain('sonde de cas limites : attente hors règle du lot, non commitée (à reprendre en constat de revue ou en sous-tâche) : hors.spec.ts — nom vide — refus');
    expect(c.lot.proposals).toEqual(['[hors règle] hors.spec.ts — nom vide — refus']);
  });

  it("R6 — un fichier SUIVI modifié et non commité rend toujours le lot « dépôt sale après probe », et ses horsRegle sont quand même rendues au lead", async () => {
    const dirty: Handler = (call) => {
      writeFileSync(join(call.opts.cwd, 'a.ts'), '// modifié par la sonde, non commité\n');
      return claudeOut(probeReport({ horsRegle: ['a — e — attendu'] }));
    };
    const h = harness({ script: { implement: [impl('a.ts')], probe: [dirty], review: [ok] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('dépôt sale après probe : a.ts');
    expect(c.lot.proposals).toEqual(['[hors règle] a — e — attendu']);
  });

  it("R6 — la documentation de l'étape décrit le retrait du fichier non suivi laissé par la sonde", () => {
    expect(readFileSync(join(root, 'docs/orchestrate.md'), 'utf8')).toContain('fichiers non commités laissés par la session retirés');
  });
});
