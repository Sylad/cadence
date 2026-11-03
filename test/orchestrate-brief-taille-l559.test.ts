import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { realClaude, buildArgs, type StepSpec } from '../src/orchestrate/launch.js';
import { reglesDuLotPourBrief } from '../src/orchestrate/accept-regles.js';
import { ficheRules, avalFicheText } from '../src/orchestrate/aval.js';
import { gitRepo, tempDir } from './helpers.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { ecritAcceptation } from './accept-helpers.js';
import { acceptReport, claudeOut, commitFile, git, harness, reviewReport, workReport } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';

// L559 (issue #27) : un brief de plus de 128 Kio (MAX_ARG_STRLEN) ne passe plus en argument de claude -p mais par stdin ; {{fiche}} se réduit aux règles du lot.

const MAX_ARG_STRLEN = 128 * 1024;

const spec = (brief: string): StepSpec => ({ brief, model: 'sonnet', effort: 'medium', schema: { type: 'object' }, cwd: '.', wave: 'w', permissionMode: 'auto', addDirs: [], timeoutMs: 30_000, sessionId: 'sid-1' }) as unknown as StepSpec;

/** Faux `claude` : écrit dans un fichier ce qu'il a reçu en argument et sur stdin. */
function fauxClaude(dir: string): { bin: string; argv: string; stdin: string } {
  const bin = join(dir, 'fake-claude.mjs');
  const argv = join(dir, 'argv.json');
  const stdin = join(dir, 'stdin.txt');
  writeFileSync(bin, `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));\nwriteFileSync(${JSON.stringify(stdin)}, readFileSync(0, 'utf8'));\nprocess.stdout.write('{}');\n`, { mode: 0o755 });
  return { bin, argv, stdin };
}
const lire = async (f: string) => (await import('node:fs')).readFileSync(f, 'utf8');

describe('L559 — le brief passe par stdin, quelle que soit sa taille', () => {
  it('un brief de plus de 128 Kio : la session démarre (pas de E2BIG) et reçoit le brief entier sur stdin', async () => {
    const dir = tempDir();
    const f = fauxClaude(dir);
    const brief = `Work on lot \`L1\`\n${'règle é '.repeat(40_000)}fin`;
    expect(Buffer.byteLength(brief)).toBeGreaterThan(MAX_ARG_STRLEN);
    const out = await realClaude(f.bin, process.env)(buildArgs(spec(brief), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(await lire(f.stdin)).toBe(brief);
  });

  it('un petit brief passe aussi par stdin : aucun argument ne le porte, `-p` reste suivi des options', async () => {
    const dir = tempDir();
    const f = fauxClaude(dir);
    const out = await realClaude(f.bin, process.env)(buildArgs(spec('petit brief'), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(out.code).toBe(0);
    expect(await lire(f.stdin)).toBe('petit brief');
    const argv = JSON.parse(await lire(f.argv)) as string[];
    expect(argv.slice(0, 2)).toEqual(['-p', '--output-format']);
    expect(argv).not.toContain('petit brief');
  });

  it("une session qui sort sans lire son stdin ne fait pas tomber l'orchestrateur (EPIPE)", async () => {
    const dir = tempDir();
    const bin = join(dir, 'fake.sh');
    writeFileSync(bin, "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
    const out = await realClaude(bin, process.env)(buildArgs(spec('x'.repeat(2_000_000)), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(out.code).toBe(0);
  });

  it("sans `-p` en tête (appel sans prompt), les arguments sont passés tels quels et stdin reste fermé", async () => {
    const dir = tempDir();
    const f = fauxClaude(dir);
    const out = await realClaude(f.bin, process.env)(['--version'], { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(out.code).toBe(0);
    expect(JSON.parse(await lire(f.argv))).toEqual(['--version']);
    expect(await lire(f.stdin)).toBe('');
  });
});

describe('L559 — {{fiche}} se réduit aux règles du lot', () => {
  const regle = (id: string) => ({ id, cas: ['C1'], statut: 'acquis', enonce: `énoncé ${id}`, tests: [`${id} — cas`] });
  const DIR = 'docs/specs/x';
  const FICHE = `${DIR}/fiche.yaml`;
  const refsOf = (text: string) => [...text.matchAll(/L\d+/g)].map((m) => ({ lot: m[0] }));
  const monde = (acceptations: Record<string, { regles?: string[] }>) => {
    const repo = gitRepo();
    mkdirSync(join(repo, DIR), { recursive: true });
    writeFileSync(join(repo, FICHE), stringify({ regles: ['R1', 'R2', 'R3', 'R4'].map(regle) }));
    for (const [lot, o] of Object.entries(acceptations)) writeFileSync(join(repo, `${DIR}/acceptation-${lot}.json`), JSON.stringify({ lot, fiche: FICHE, fichiers: ['t.test.ts'], vert: false, ...(o.regles ? { regles: o.regles } : {}) }));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'spec(L9): fiche');
    return repo;
  };
  const pour = (repo: string, lot: string, acc?: string) => reglesDuLotPourBrief({ repo, lot, fiche: FICHE, acceptation: acc, partage: { dir: 'docs/specs', refsOf } });

  it('la clé « regles » de l\'acceptation du lot fixe ses règles', () => {
    const repo = monde({ L1: { regles: ['R2', 'R3'] }, L2: { regles: ['R1'] } });
    expect([...pour(repo, 'L1', `${DIR}/acceptation-L1.json`)!]).toEqual(['R2', 'R3']);
  });

  it("sans clé « regles » sur une fiche partagée, les règles que les commits spec/docs du lot ajoutent ou modifient", () => {
    const repo = monde({ L1: {}, L2: {} });
    writeFileSync(join(repo, FICHE), stringify({ regles: [regle('R1'), { ...regle('R2'), enonce: 'modifié' }, regle('R3'), regle('R4')] }));
    git(repo, 'add', '--', FICHE);
    git(repo, 'commit', '-q', '-m', 'spec(L1): R2 amendée');
    expect([...pour(repo, 'L1', `${DIR}/acceptation-L1.json`)!]).toEqual(['R2']);
  });

  it("fiche non partagée (une seule acceptation, ou aucune), ou aucun commit du lot sur une règle : null, toutes les règles", () => {
    expect(pour(monde({ L1: {} }), 'L1', `${DIR}/acceptation-L1.json`)).toBeNull();
    expect(pour(monde({}), 'L1')).toBeNull();
    expect(pour(monde({ L1: {}, L2: {} }), 'L1', `${DIR}/acceptation-L1.json`)).toBeNull();
  });

  it('une clé « regles » vide ou mal formée vaut absente (toutes les règles, ou celles des commits)', () => {
    const repo = monde({ L1: {} });
    writeFileSync(join(repo, `${DIR}/acceptation-L1.json`), JSON.stringify({ lot: 'L1', fiche: FICHE, fichiers: ['t'], vert: false, regles: [] }));
    expect(pour(repo, 'L1', `${DIR}/acceptation-L1.json`)).toBeNull();
  });

  it('ficheRules ne garde que les règles demandées, et avalFicheText dit combien de règles d\'autres lots sont omises', () => {
    const doc = { regles: ['R1', 'R2', 'R3', 'R4'].map(regle) };
    const rules = ficheRules(doc, new Set(['R2', 'R9']));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('R2');
    expect(ficheRules(doc)).toHaveLength(4);
    const texte = avalFicheText('implement', { fiche: FICHE, rules, others: 3 });
    expect(texte).toContain('3 other rules');
    expect(avalFicheText('implement', { fiche: FICHE, rules: ficheRules(doc) })).not.toContain('other rules');
  });
});

describe('L559 — le brief implement d\'un lot reçoit les règles de son acceptation, pas toute la fiche', () => {
  it('« regles » de acceptation-L1.json = [R1, R2] : le brief nomme R1 et R2, dit que les 2 autres sont celles d\'autres lots, et ne porte pas leur énoncé', async () => {
    const accept = (call: { opts: { cwd: string } }) => {
      const { json } = ecritAcceptation(call.opts.cwd, { sansFiche: true });
      const doc = JSON.parse(readFileSync(join(call.opts.cwd, json), 'utf8'));
      writeFileSync(join(call.opts.cwd, json), JSON.stringify({ ...doc, regles: ['R1', 'R2'] }, null, 2));
      git(call.opts.cwd, 'add', '--', json);
      git(call.opts.cwd, 'commit', '-q', '--amend', '--no-edit');
      return claudeOut(acceptReport());
    };
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' as const }], script: { accept: [accept], implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'done.flag', 'feat(L1): a')] }))], ux: [() => claudeOut(reviewReport())], review: [() => claudeOut(reviewReport())] } });
    ecrit(h.repo);
    const c = h.lot('L1', { visible: true, screen: 'page' as const }, { ux: { url: 'http://localhost:4200' }, accept: 'test -f done.flag', test: 'true' });
    await runLot(c);
    const brief = h.calls.find((x) => x.kind === 'implement')!.brief;
    expect(brief).toContain('- R1 [');
    expect(brief).toContain('- R2 [');
    expect(brief).not.toContain('- R3 [');
    expect(brief).not.toContain('- R4 [');
    expect(brief).toContain('2 other rules');
  });
});
