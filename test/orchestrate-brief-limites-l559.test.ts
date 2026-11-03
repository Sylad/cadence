import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { realClaude, buildArgs, buildLocalArgs, buildRetryArgs, type StepSpec } from '../src/orchestrate/launch.js';
import { reglesDuLotPourBrief } from '../src/orchestrate/accept-regles.js';
import { ficheRules, avalFicheText } from '../src/orchestrate/aval.js';
import { gitRepo, tempDir } from './helpers.js';
import { git } from './orchestrate-harness.js';

// Sonde L559 : les bords du passage du brief par stdin et de la réduction de {{fiche}} aux règles du lot.

const spec = (brief: string): StepSpec => ({ brief, model: 'sonnet', effort: 'medium', schema: { type: 'object' }, cwd: '.', wave: 'w', permissionMode: 'auto', addDirs: [], timeoutMs: 30_000, sessionId: 'sid-1' }) as unknown as StepSpec;

function fauxClaude(dir: string): { bin: string; argv: string; stdin: string } {
  const bin = join(dir, 'fake-claude.mjs');
  const argv = join(dir, 'argv.json');
  const stdin = join(dir, 'stdin.txt');
  writeFileSync(bin, `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));\nwriteFileSync(${JSON.stringify(stdin)}, readFileSync(0, 'utf8'));\nprocess.stdout.write('{}');\n`, { mode: 0o755 });
  return { bin, argv, stdin };
}
const lire = (f: string) => readFileSync(f, 'utf8');

describe('L559 limites — le prompt sur stdin', () => {
  it('brief vide : stdin reçoit une chaîne vide et -p reste en tête sans argument de prompt', async () => {
    const dir = tempDir();
    const f = fauxClaude(dir);
    const out = await realClaude(f.bin, process.env)(buildArgs(spec(''), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(out.code).toBe(0);
    expect(lire(f.stdin)).toBe('');
    expect(JSON.parse(lire(f.argv))[0]).toBe('-p');
    expect(JSON.parse(lire(f.argv))[1]).toBe('--output-format');
  });

  it('brief qui commence par « -- » ou « - » : ni pris pour une option (il est sur stdin), ni perdu', async () => {
    const dir = tempDir();
    const f = fauxClaude(dir);
    const brief = '--model opus\n-p evil';
    await realClaude(f.bin, process.env)(buildArgs(spec(brief), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(lire(f.stdin)).toBe(brief);
    expect(JSON.parse(lire(f.argv))).not.toContain(brief);
  });

  it('brief multi-octets et NUL / retours chariot : transmis octet pour octet', async () => {
    const dir = tempDir();
    const f = fauxClaude(dir);
    const brief = 'é😀\r\n\ttab « guillemets »   fin';
    await realClaude(f.bin, process.env)(buildArgs(spec(brief), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(lire(f.stdin)).toBe(brief);
  });

  it('la relance de mise en forme (--resume) passe aussi son prompt par stdin', async () => {
    const dir = tempDir();
    const f = fauxClaude(dir);
    const args = buildRetryArgs(spec('x'), 'sid-9', {});
    await realClaude(f.bin, process.env)(args, { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(args[0]).toBe('-p');
    expect(lire(f.stdin)).toBe(args[1]);
    expect(JSON.parse(lire(f.argv))).toContain('--resume');
    expect(JSON.parse(lire(f.argv))).not.toContain(args[1]);
  });

  it('deux sessions de suite avec le même lanceur : chacune reçoit son propre brief', async () => {
    const dir = tempDir();
    const f = fauxClaude(dir);
    const run = realClaude(f.bin, process.env);
    await run(buildArgs(spec('premier'), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(lire(f.stdin)).toBe('premier');
    await run(buildArgs(spec('second'), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(lire(f.stdin)).toBe('second');
  });

  it('une session qui sort aussitôt sans lire un brief de 3 Mo : le code de sortie et la sortie sont rendus, pas de rejet', async () => {
    const dir = tempDir();
    const bin = join(dir, 'fail.sh');
    writeFileSync(bin, "#!/bin/sh\necho 'boom' >&2\nexit 3\n", { mode: 0o755 });
    const out = await realClaude(bin, process.env)(buildArgs(spec('y'.repeat(3_000_000)), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(out.code).toBe(3);
    expect(out.stderr).toContain('boom');
  });

  it('binaire absent : échec rendu proprement (pas de crash sur stdin.end d\'un enfant sans pid)', async () => {
    const dir = tempDir();
    const out = await realClaude(join(dir, 'inexistant'), process.env)(buildArgs(spec('x'), {}), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(out.code).not.toBe(0);
  });

  it('claude-local avec un brief de plus de 128 Kio : la session démarre, le brief est lu dans un fichier que $1 désigne', async () => {
    const dir = tempDir();
    const f = fauxClaude(dir);
    const brief = 'règle é '.repeat(40_000);
    expect(Buffer.byteLength(brief)).toBeGreaterThan(128 * 1024);
    const out = await realClaude('claude', process.env, f.bin)(buildLocalArgs(spec(brief), {}), { cwd: dir, env: {}, timeoutMs: 30_000, local: true });
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const argv = JSON.parse(lire(f.argv)) as string[];
    expect(Buffer.byteLength(argv[0]!)).toBeLessThan(4096);
    const file = /(\/\S+\.md)/.exec(argv[0]!)?.[1];
    expect(file).toBeDefined();
    expect(existsSync(file!)).toBe(false); // supprimé à la fin de la session
  });

  it('claude-local avec un brief de plus de 128 Kio : le fichier du brief existe pendant la session et contient le brief entier', async () => {
    const dir = tempDir();
    const bin = join(dir, 'peek.mjs');
    const copy = join(dir, 'copy.txt');
    writeFileSync(bin, `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst f = /(\\/\\S+\\.md)/.exec(process.argv[2])[1];\nwriteFileSync(${JSON.stringify(copy)}, readFileSync(f, 'utf8'));\nprocess.stdout.write('{}');\n`, { mode: 0o755 });
    const brief = 'règle é '.repeat(40_000);
    const out = await realClaude('claude', process.env, bin)(buildLocalArgs(spec(brief), {}), { cwd: dir, env: { TMPDIR: dir }, timeoutMs: 30_000, local: true });
    expect(out.code).toBe(0);
    expect(lire(copy)).toBe(brief);
  });

  it('claude-local avec un brief court : le prompt reste en $1, sans fichier', async () => {
    const dir = tempDir();
    const f = fauxClaude(dir);
    await realClaude('claude', process.env, f.bin)(buildLocalArgs(spec('court'), {}), { cwd: dir, env: {}, timeoutMs: 30_000, local: true });
    expect((JSON.parse(lire(f.argv)) as string[])[0]).toBe('court');
  });
});

describe('L559 limites — les règles du lot pour le brief', () => {
  const regle = (id: string | number) => ({ id, cas: ['C1'], statut: 'acquis', enonce: `énoncé ${id}`, tests: [`${id} — cas`] });
  const DIR = 'docs/specs/x';
  const FICHE = `${DIR}/fiche.yaml`;
  const refsOf = (text: string) => [...text.matchAll(/L\d+/g)].map((m) => ({ lot: m[0] }));
  const monde = (acc: Record<string, unknown>) => {
    const repo = gitRepo();
    mkdirSync(join(repo, DIR), { recursive: true });
    writeFileSync(join(repo, FICHE), stringify({ regles: ['R1', 'R2', 'R3'].map(regle) }));
    writeFileSync(join(repo, `${DIR}/acceptation-L1.json`), JSON.stringify({ lot: 'L1', fiche: FICHE, fichiers: ['t'], vert: false, ...acc }));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'spec(L1): fiche');
    return repo;
  };
  const ACC = `${DIR}/acceptation-L1.json`;
  const pour = (repo: string, acc?: string) => reglesDuLotPourBrief({ repo, lot: 'L1', fiche: FICHE, acceptation: acc, partage: { dir: 'docs/specs', refsOf } });

  it('« regles » avec doublons : un ensemble sans doublon', () => {
    expect([...pour(monde({ regles: ['R1', 'R1', 'R2'] }), ACC)!].sort()).toEqual(['R1', 'R2']);
  });

  it('« regles » est un objet ou une chaîne : traité comme absent (null), sans exception', () => {
    expect(pour(monde({ regles: { R1: true } }), ACC)).toBeNull();
    expect(pour(monde({ regles: 'R1' }), ACC)).toBeNull();
  });

  it('« regles » avec un id numérique ou vide : traité comme absent', () => {
    expect(pour(monde({ regles: ['R1', 2] }), ACC)).toBeNull();
    expect(pour(monde({ regles: ['R1', ''] }), ACC)).toBeNull();
    expect(pour(monde({ regles: [null] }), ACC)).toBeNull();
  });

  it('acceptation absente du disque, JSON illisible, ou chemin hors du dépôt : null, sans exception', () => {
    const repo = monde({});
    expect(pour(repo, `${DIR}/acceptation-L7.json`)).toBeNull();
    writeFileSync(join(repo, `${DIR}/acceptation-L1.json`), '{pas du json');
    expect(pour(repo, ACC)).toBeNull();
    expect(pour(repo, '../../../etc/passwd')).toBeNull();
    expect(pour(repo, '')).toBeNull();
  });

  it('dépôt sans historique git (répertoire simple) : null, sans exception', () => {
    const dir = tempDir();
    mkdirSync(join(dir, DIR), { recursive: true });
    writeFileSync(join(dir, ACC), JSON.stringify({ lot: 'L1', fiche: FICHE, fichiers: ['t'], vert: false }));
    expect(() => pour(dir, ACC)).not.toThrow();
    expect(pour(dir, ACC)).toBeNull();
  });

  it('ficheRules : ensemble vide donné → aucune règle (le repli « toutes » est à la charge de l\'appelant) ; null et undefined → toutes', () => {
    const doc = { regles: [regle('R1'), regle('R2')] };
    expect(ficheRules(doc, new Set())).toHaveLength(0);
    expect(ficheRules(doc, null)).toHaveLength(2);
    expect(ficheRules(doc, undefined)).toHaveLength(2);
  });

  it('ficheRules : ids numériques dans la fiche (id: 1) retrouvés par leur forme chaîne', () => {
    expect(ficheRules({ regles: [regle(1), regle(2)] }, new Set(['2']))).toHaveLength(1);
  });

  it('ficheRules : document sans liste « regles », null, ou règles non objets : vide même avec un filtre', () => {
    expect(ficheRules(null, new Set(['R1']))).toEqual([]);
    expect(ficheRules({ regles: 'R1' }, new Set(['R1']))).toEqual([]);
    expect(ficheRules({ regles: [null, 3, 'R1'] }, new Set(['R1']))).toEqual([]);
  });

  it('avalFicheText : others = 0, undefined, ou 1 (pluriel) : aucune phrase ou une phrase correcte, pour chaque type d\'étape', () => {
    const rules = ['- R1 [x] a'];
    for (const kind of ['implement', 'fix', 'review'] as const) {
      expect(avalFicheText(kind, { fiche: FICHE, rules, others: 0 })).not.toContain('other rules');
      expect(avalFicheText(kind, { fiche: FICHE, rules, others: 5 })).toContain('5 other rules');
    }
    expect(avalFicheText('implement', { fiche: FICHE, rules, others: 1, screen: false })).toContain('1 other rules');
  });
});
