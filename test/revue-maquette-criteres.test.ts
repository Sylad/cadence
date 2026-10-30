import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { readOrchestrateConfig } from '../src/config.js';
import { REVIEW_SCHEMA } from '../src/orchestrate/schemas.js';
import { AGENTS_DIR, installAgents } from '../src/skills.js';
import { claudeOut, commitFile, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';
import { changelogSectionOf } from './changelog-section.js';
import { tempDir } from './helpers.js';
import { writeJournal, writeWave } from './perf-helpers.js';

// L448 (spec revue-maquette-criteres-design) : critères de design repris dans la revue de maquette (ux-reviewer, mode maquette) et dans le spec-writer.
const root = join(__dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const empreinte = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const entre = (t: string, a: string, b?: string) => t.slice(t.indexOf(a), b ? t.indexOf(b) : undefined);
const nb = (t: string, s: string) => t.split(s).length - 1;

const ux = read('agents/ux-reviewer.md');
const writer = read('agents/spec-writer.md');
const mockup = entre(ux, '## Mockup mode', '## Conformity mode');
const FAMILLES = ['visual hierarchy', 'consistency with the product tokens', 'quality of the texts', 'complementary accessibility'];
// Le bloc des critères repris : de son titre à la fin de la section Mockup mode ; ses puces sont les critères.
const bloc = entre(mockup, '**Criteria added in mockup mode**', '**Sweep everything');
const puces = bloc.split('\n').filter((l) => /^\s*- /.test(l));

const lots = [{ title: 'Un écran', screen: 'page' as const }];
const screen = { visible: true, screen: 'page' as const };
const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
const hors: Handler = () => claudeOut(specReport({ fiche: 'autre/dossier/fiche.yaml' }));
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', texte: 'message sans correction' }], verdict: 'non conforme : 1 majeur' }));
const cfg = { maquette: true };
const brief = async (kind: 'maquette' | 'spec') => {
  const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
  await runLot(h.lot('L1', screen, cfg));
  return h.calls.find((c) => c.kind === kind)!.brief;
};

describe('R1/R2/R3 — les critères repris dans la section Mockup mode', () => {
  it('R1 — la section Mockup mode de ux-reviewer.md contient les quatre familles de critères', () => {
    expect(bloc.length).toBeGreaterThan(0);
    for (const f of FAMILLES) expect(bloc, f).toContain(f);
  });
  it('R1 — le contenu hors de la section Mockup mode n’est pas déplacé (Method et Conformity mode inchangés)', () => {
    expect(empreinte(entre(ux, '## Inputs', '## Mockup mode'))).toBe('1b95a900c30a9113');
    expect(empreinte(entre(ux, '## Conformity mode', '## Method'))).toBe('0e678bf38c96081f');
    expect(empreinte(entre(ux, '## Method', '## Output'))).toBe('f6d00d8463947ffa');
    expect(empreinte(entre(ux, '## Output', '\n## Short reply'))).toBe('3f3791ca62eb6631');
    expect(ux.indexOf('## Mockup mode')).toBeLessThan(ux.indexOf('## Conformity mode'));
  });
  it('R2 — ux-reviewer.md ne contient ni « WCAG 2.1 » ni « 2.5.5 » ni « What works well »', () => {
    for (const s of ['WCAG 2.1', '2.5.5', 'What works well']) expect(ux, s).not.toContain(s);
  });
  it('R2 — chaque critère de contraste, cible, reflow n’apparaît pas deux fois dans la section Mockup mode', () => {
    // Écrits une fois, dans Method : la section Mockup mode ne les reprend pas, et le fichier ne les répète pas.
    for (const s of ['4.5:1', '24×24', '320 px', '44 px']) {
      expect(nb(mockup, s), `${s} dans Mockup mode`).toBe(0);
      expect(nb(ux, s), `${s} dans le fichier`).toBe(1);
    }
    expect(nb(mockup, 'no information carried by colour alone')).toBe(0);
    expect(nb(mockup, 'text alternatives')).toBe(0);
  });
  it('R3 — chaque puce du bloc des critères repris contient « Nielsen » suivi d’un numéro, ou un numéro de critère WCAG, ou le mot « count »', () => {
    expect(puces.length).toBeGreaterThanOrEqual(10);
    for (const p of puces) expect(p, p).toMatch(/Nielsen \d|\b\d\.\d\.\d\b|\bcount\b/);
  });
  it('R3 — les onze règles ou mesures de l’énoncé sont chacune présentes dans l’agent', () => {
    const attendu = [
      'one primary element per state', 'Nielsen 8',
      'do not come from the product’s CSS variables', 'Nielsen 4',
      'what, why, how to fix', 'Nielsen 9',
      'what it is, why it is empty, how to start', 'Nielsen 1',
      'verb that names the result', 'Nielsen 2',
      'names the object and the consequence', 'Nielsen 5',
      'one word per notion', 'count of distinct labels',
      '2.4.3', '4.1.2', '3.3.2', '1.3.1', '3.3.1', '1.4.4',
    ];
    for (const a of attendu) expect(bloc, a).toContain(a);
  });
});

describe('R4/R5/R6 — liste à cocher, nonVerifie, gravité', () => {
  it('R4 — le brief maquette rendu contient les quatre familles et les sept points de L230', async () => {
    const b = await brief('maquette');
    for (const f of FAMILLES) expect(b, f).toContain(f);
    for (const p of ['every state of the sheet at 1440 px and at 390 px', 'every rule of the sheet', 'contrast', 'real envelope of the app', 'gutters', 'empty or stretched panels', 'holes']) expect(b, p).toContain(p);
  });
  it('R4 — le brief garde « ALL the blocking and major findings in this first report »', async () => {
    expect(await brief('maquette')).toContain('ALL the blocking and major findings in this first report');
  });
  it('R4 — agents/ux-reviewer.md garde les dix points testés par L230 (checklist, nonVerifie, every state…) et met une ligne par famille dans la liste', () => {
    for (const p of ['checklist', 'nonVerifie', 'every state', 'every rule', 'contrast', 'real envelope', 'gutters', 'empty or stretched panels', 'holes', 'ALL the blocking and major']) expect(mockup, p).toContain(p);
    expect(mockup).toMatch(/one line per family of the added criteria, per state at 1440 px and 390 px/);
  });
  it('R5 — ux-reviewer.md range le lecteur d’écran réel dans nonVerifie', () => {
    expect(bloc).toMatch(/real screen reader[^\n]*`nonVerifie`[^\n]*not ticked/);
  });
  it('R5 — le brief maquette garde « what you cannot verify goes in `nonVerifie`, not ticked »', async () => {
    expect(await brief('maquette')).toContain('what you cannot verify goes in `nonVerifie`, not ticked');
  });
  it('R6 — ux-reviewer.md classe un texte d’erreur sans correction en majeur seulement s’il trompe la tâche', () => {
    expect(bloc).toMatch(/major only if it misleads or slows the task[^\n]*error message without the fix[^\n]*two primary actions[^\n]*off-token value[^\n]*otherwise minor/);
    expect(bloc).toMatch(/accessibility \(WCAG\) gap[^\n]*blocking or major/);
  });
  it('R6 — l’échelle bloquant / majeur / minor de l’agent reste inchangée', () => {
    const method = entre(ux, '## Method', '## Output');
    expect(method).toContain('*blocking* (a user cannot complete the task, or an accessibility failure)');
    expect(method).toContain('*major* (slows or misleads)');
    expect(method).toContain('*minor* (polish)');
  });
});

describe('R7/R8 — mode maquette seul, aucune dépendance', () => {
  it('R7 — les sections Conformity mode et Method de ux-reviewer.md sont identiques à celles d’avant le lot', () => {
    expect(empreinte(entre(ux, '## Conformity mode', '## Method'))).toBe('0e678bf38c96081f');
    expect(empreinte(entre(ux, '## Method', '## Output'))).toBe('f6d00d8463947ffa');
    expect(entre(ux, '## Conformity mode', '## Method')).toContain('this is **not the full audit**');
    expect(bloc).not.toContain('Conformity');
  });
  it('R7 — templates/orchestrate/ux.md n’est pas modifié', () => {
    expect(empreinte(read('templates/orchestrate/ux.md'))).toBe('febe94677a4b9be7');
  });
  it('R8 — aucun fichier de agents/ ni de templates/orchestrate/ ne contient « knowledge-work-plugins », « design-critique », « ux-copy », « accessibility-review » ni « Anthropic »', () => {
    const fichiers = [...readdirSync(join(root, 'agents')).map((f) => `agents/${f}`), ...readdirSync(join(root, 'templates/orchestrate')).map((f) => `templates/orchestrate/${f}`)];
    expect(fichiers.length).toBeGreaterThan(5);
    for (const f of fichiers) for (const s of ['knowledge-work-plugins', 'design-critique', 'ux-copy', 'accessibility-review', 'Anthropic']) expect(read(f), `${f} : ${s}`).not.toContain(s);
  });
  it('R8 — le front matter tools de ux-reviewer et de spec-writer est identique à celui d’avant', () => {
    expect(ux.match(/^tools: .*$/m)![0]).toBe('tools: Read, Grep, Glob, Bash, mcp__playwright, mcp__plugin_playwright_playwright');
    expect(writer.match(/^tools: .*$/m)![0]).toBe('tools: Read, Write, Edit, Grep, Glob, Bash');
  });
});

describe('R9/R10/R11 — le spec-writer', () => {
  const consignes = ['what, why, how to fix', 'what it is, why it is empty, how to start', 'verb that names the result', 'names the object and the consequence', 'one word per notion'];
  it('R9 — spec-writer.md contient les structures d’erreur, d’état vide, de libellé et de confirmation', () => {
    for (const c of consignes) expect(writer, c).toContain(c);
    expect(writer).toMatch(/already in the product[^\n]*kept as it is/);
  });
  it('R9 — le brief spec.md rendu contient la même consigne', async () => {
    const b = await brief('spec');
    for (const c of consignes) expect(b, c).toContain(c);
    expect(b).toMatch(/already in the product[^\n]*kept as it is/);
  });
  it('R9 — spec-writer.md garde « reuse what exists »', () => {
    expect(writer).toContain('reuse what exists');
  });
  it('R10 — spec-writer.md ne contient ni « 200 % » ni « 2.4.3 »', () => {
    for (const s of ['200 %', '2.4.3', '4.1.2', 'focus order']) expect(writer, s).not.toContain(s);
  });
  it('R10 — templates/orchestrate/spec-back.md n’est pas modifié', () => {
    expect(empreinte(read('templates/orchestrate/spec-back.md'))).toBe('ea28168b9e1c409c');
  });
  it('R11 — une fiche valide avant le lot passe cadence spec check après le lot', async () => {
    const out: string[] = [];
    const code = await run(['spec', 'check', join(root, 'docs/specs/revue-maquette-criteres-design/fiche.yaml')], { cwd: root, env: {}, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date() });
    expect(code, out.join('\n')).toBe(0);
  });
  it('R11 — templates/fiche.yaml et le schéma de la fiche ne sont pas modifiés', () => {
    expect(empreinte(read('templates/fiche.yaml'))).toBe('325496e3942ce749');
    // le schéma : la validation de `cadence spec check` (src/spec.ts, src/orchestrate/spec.ts)
    expect(empreinte(read('src/spec.ts'))).toBe('bad3c070476b92bc');
    expect(empreinte(read('src/orchestrate/spec.ts'))).toBe('5f5d582e1fd9364e');
  });
  it('R3 — un produit sans variables CSS : un seul constat chiffré, pas un par valeur, repli noté dans nonVerifie', () => {
    const jetons = puces.find((l) => l.includes('CSS variables')) ?? '';
    expect(jetons).toContain('one finding');
    expect(jetons).toContain('no CSS variables');
    expect(jetons).toContain('nonVerifie');
    expect(writer).toContain('no CSS variables');
  });
});

describe('R12/R13/R14/R15 — budgets, indicateur, installation, documentation', () => {
  it('R12 — maquetteReviews absent : plafond 3', () => {
    expect(readOrchestrateConfig('/nope').maquetteReviews).toBe(3);
  });
  it('R12 — REVIEW_SCHEMA accepte et refuse les mêmes rapports qu’avant', () => {
    expect(empreinte(JSON.stringify(REVIEW_SCHEMA))).toBe('71e7e4ef2c4e0e6a');
  });
  it('R12 — trois revues non conformes : lot rendu « maquette non conforme après 3 revues : »', async () => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], maquette: [major, major, major] } });
    const c = h.lot('L1', screen, cfg);
    await runLot(c);
    expect(h.calls.map((x) => x.kind)).toEqual(['spec', 'maquette', 'spec', 'maquette', 'spec', 'maquette']);
    expect(c.lot.outcome).toContain('maquette non conforme après 3 revues : ');
  });
  it('R12 — lot à écran : le plafond de sessions spec reste 3', async () => {
    const h = harness({ lots, script: { spec: [hors, hors, hors, hors] } });
    await runLot(h.lot('L1', screen, cfg));
    expect(h.calls.map((x) => x.kind)).toEqual(['spec', 'spec', 'spec']);
  });

  const perf = async (r: string) => {
    const out: string[] = [];
    await run(['perf', '--json'], { cwd: r, env: { RAF_TODAY: '2026-10-16' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-16T10:00:00') });
    return JSON.parse(out.join('\n'));
  };
  const projet = () => {
    const r = tempDir();
    const runs = join(r, '.cadence', 'runs');
    mkdirSync(runs, { recursive: true });
    writeWave(runs, 'w1', '2026-10-01T08:00:00');
    return { r, runs };
  };
  it('R13 — cadence perf imprime toujours la ligne « sessions ux par lot visible »', async () => {
    const { r, runs } = projet();
    writeJournal(runs, 'w1', 'alpha', 'LA', { status: 'ready', visible: true, small: false, steps: [{ kind: 'implement', ended: '2026-10-12T09:00:00' }, { kind: 'ux', ended: '2026-10-12T10:00:00' }, { kind: 'ux', ended: '2026-10-12T11:00:00' }] });
    expect((await perf(r)).interventions.ux.current).toBe(2);
    const out: string[] = [];
    await run(['perf'], { cwd: r, env: { RAF_TODAY: '2026-10-16' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-16T10:00:00') });
    expect(out.join('\n')).toContain('sessions ux par lot visible');
  });
  it('R13 — deux fenêtres sans lot visible : indicateur sans valeur, comme avant', async () => {
    const { r, runs } = projet();
    writeJournal(runs, 'w1', 'alpha', 'LB', { status: 'ready', visible: false, steps: [{ kind: 'implement', ended: '2026-10-12T09:00:00' }] });
    const d = await perf(r);
    expect(d.interventions.ux.current).toBeNull();
    expect(d.interventions.ux.previous).toBeNull();
  });

  it('R14 — agent installé puis modifié à la main : réinstallation sans écrasement', () => {
    const dest = join(tempDir(), 'agents');
    installAgents(AGENTS_DIR, dest, false);
    const f = join(dest, 'cadence-ux-reviewer.md');
    writeFileSync(f, 'à la main');
    expect(() => installAgents(AGENTS_DIR, dest, false)).toThrow(/cadence-ux-reviewer.*--force/);
    expect(readFileSync(f, 'utf8')).toBe('à la main');
  });
  it('R14 — agent installé non modifié : reçoit le texte renforcé', () => {
    const dest = join(tempDir(), 'agents');
    expect(installAgents(AGENTS_DIR, dest, false).find((a) => a.name === 'cadence-ux-reviewer')?.status).toBe('installed');
    expect(readFileSync(join(dest, 'cadence-ux-reviewer.md'), 'utf8')).toContain('**Criteria added in mockup mode**');
    expect(installAgents(AGENTS_DIR, dest, false).every((a) => a.status === 'unchanged')).toBe(true);
  });

  it('R15 — CHANGELOG.md, section Unreleased, contient les quatre familles', () => {
    const s = changelogSectionOf(read('CHANGELOG.md'), 'L448');
    expect(s.startsWith('## [')).toBe(true);
    for (const f of FAMILLES) expect(s.toLowerCase(), f).toContain(f);
    for (const x of ['knowledge-work-plugins', 'design-critique', 'Anthropic']) expect(s).not.toContain(x);
  });
  it('R15 — docs/orchestrate.md décrit les critères de l’étape maquette', () => {
    const d = entre(read('docs/orchestrate.md'), '- **The session**: the `ux-reviewer` agent in **mockup mode**', '- **The loop,');
    expect(d).toContain('L448');
    for (const f of FAMILLES) expect(d.toLowerCase(), f).toContain(f);
    for (const x of ['knowledge-work-plugins', 'design-critique', 'Anthropic']) expect(d).not.toContain(x);
  });
});
