import { describe, expect, it } from 'vitest';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { parseOrchestrateArgs } from '../src/orchestrate/command-args.js';
import { fillsFreeSlots } from '../src/orchestrate/continue.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, kindOf, reviewReport, precheckReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { execFileSync } from 'node:child_process';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repoAt(dir: string, name: string, lots = 1) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
  for (let i = 0; i < lots; i++) plan.add('lot', '2026-10-01', { estimate: 1 });
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
  git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
  git(dir, 'commit', '-q', '-m', 'chore: plan');
}

function parentWith(names: string[], lotsOf: Record<string, number> = {}) {
  const parent = tempDir();
  for (const n of names) repoAt(join(parent, n), n, lotsOf[n] ?? 1);
  writeFileSync(join(parent, 'cadence.yaml'), `priority: [${names.join(', ')}]\n`);
  return parent;
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') };
  return { io: i, out, err };
}

function scene() {
  const played: string[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    if (kind === 'precheck') return claudeOut(precheckReport());
    if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
    const lot = /on lot `([^`]+)`/.exec(args[1])![1];
    played.push(`${o.cwd.split('/').pop()!.replace(/^.*--/, '')}:${lot}`);
    await new Promise((r) => setTimeout(r, 30));
    return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
  return { d, played };
}

const journal = (parent: string) => readFileSync(join(RunStore.last(parent)!.dir, 'journal.log'), 'utf8');

describe('L587 probe — --no-fill et fillsFreeSlots', () => {
  it('fillsFreeSlots : ni lots ni --continue → faux ; lots → vrai ; --no-fill l\'emporte', () => {
    expect(fillsFreeSlots({ continue: false, lots: [], noFill: false })).toBe(false);
    expect(fillsFreeSlots({ continue: false, lots: [{ project: 'a', lot: 'L1' }] as never, noFill: false })).toBe(true);
    expect(fillsFreeSlots({ continue: true, lots: [], noFill: false })).toBe(true);
    expect(fillsFreeSlots({ continue: true, lots: [{ project: 'a', lot: 'L1' }] as never, noFill: true })).toBe(false);
  });

  it('--no-fill répété deux fois : accepté, noFill vrai', () => {
    const a = parseOrchestrateArgs(['a:L1', '--no-fill', '--no-fill']);
    expect(a.noFill).toBe(true);
    expect(a.lots).toHaveLength(1);
  });

  it('sans --no-fill, noFill est faux par défaut', () => {
    expect(parseOrchestrateArgs(['a:L1']).noFill).toBe(false);
    expect(parseOrchestrateArgs(['--continue']).noFill).toBe(false);
  });

  it('--no-fill seul est refusé avec le message du lot', () => {
    expect(() => parseOrchestrateArgs(['--no-fill'])).toThrow("--no-fill s'utilise avec des lots donnés ou avec --continue");
  });

  it('--no-fill avec --resume sans lot ni --continue : le refus ne doit pas casser la reprise d\'une vague', () => {
    // la reprise rejoue la vague telle quelle (doc) : --no-fill y est un no-op inoffensif, pas une erreur de syntaxe
    expect(() => parseOrchestrateArgs(['--resume', '--no-fill'])).not.toThrow();
  });

  it('--no-fill avec --add seul : sans effet, pas refusé par le parseur', () => {
    expect(() => parseOrchestrateArgs(['--add', 'a:L2', '--no-fill'])).not.toThrow();
  });

  it('--no-fill ne devient pas la valeur de --goal / --wave quand il suit un drapeau à valeur optionnelle', () => {
    const a = parseOrchestrateArgs(['--status', '--no-fill', '--continue']);
    expect(a.status).toBe(true);
    expect(a.noFill).toBe(true);
  });

  it('un drapeau inconnu hérité de Object.prototype (--constructor) n\'est pas pris pour un booléen', () => {
    expect(() => parseOrchestrateArgs(['a:L1', 'constructor'])).not.toThrow(/Cannot|not a function/);
    expect(() => parseOrchestrateArgs(['a:L1', '--toString'])).toThrow();
  });
});

describe('L587 probe — vague de lots nommés', () => {
  it('dépôt seul sans cadence.yaml parent : une vague de lot nommé ne plante pas à la lecture de priority:', async () => {
    // Sous-dossier d'un parent à soi, à titre de précaution : à la racine temporaire partagée, le dépôt aurait pour frères les dépôts des autres tests
    // joués en parallèle (readyFree / sharingProjects les scanne : 30 s au lieu de 1 s avec 300 frères, mais code 0). La cause du code 1 vu sur le runner
    // GitHub n'est pas établie (non reproduite avec HOME vide, sans config git globale, CI=true) : si ce test rougit encore, le message porte la vague.
    const repo = join(tempDir(), 'solo');
    repoAt(repo, 'solo', 2);
    const s = scene();
    const run = io(repo);
    const code = await orchestrate(['L1', '--max-sessions', '2'], run.io, s.d);
    const vague = () => {
      try { return readFileSync(join(RunStore.last(repo)!.dir, 'journal.log'), 'utf8'); } catch { return '(pas de journal)'; }
    };
    expect(code, code === 0 ? '' : `sortie :\n${run.out.join('\n')}\nerreurs :\n${run.err.join('\n')}\njournal :\n${vague()}\njoués : ${s.played.join(', ')}`).toBe(0);
    expect(s.played.some((p) => p.endsWith(':L1'))).toBe(true);
  });

  it('priority: illisible + --dry-run + lots nommés : refus (même contrat que --continue)', async () => {
    const parent = parentWith(['a']);
    writeFileSync(join(parent, 'cadence.yaml'), 'priority: nope\n');
    await expect(orchestrate(['a:L1', '--dry-run'], io(parent).io, scene().d)).rejects.toThrow(/priority/);
  });

  it('le lot nommé n\'est joué qu\'une fois et la vague s\'arrête quand le plan est épuisé (pas de boucle de tirage)', async () => {
    const parent = parentWith(['a', 'b'], { a: 1, b: 1 });
    const s = scene();
    expect(await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
    expect(s.played.sort()).toEqual(['a:L1', 'b:L1']);
    expect(s.played.filter((p) => p === 'a:L1')).toHaveLength(1);
  });

  it('budget minuscule : aucun lot n\'est tiré au-delà du budget, aucune ligne « créneau libre rempli »', async () => {
    const parent = parentWith(['a', 'b', 'c']);
    const s = scene();
    await orchestrate(['a:L1', '--budget', '1', '--max-sessions', '2'], io(parent).io, s.d);
    expect(s.played).not.toContain('b:L1');
    expect(s.played).not.toContain('c:L1');
    expect(journal(parent)).not.toMatch(/créneau libre rempli par/);
  });

  it('l\'ancienne ligne « continue : tire … (créneau libre) » a disparu du journal', async () => {
    const parent = parentWith(['a', 'b']);
    const s = scene();
    await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d);
    expect(journal(parent)).not.toMatch(/continue : tire .*\(créneau libre\)/);
  });

  it('chaque tirage est une ligne du journal, une seule par lot rempli', async () => {
    const parent = parentWith(['a', 'b', 'c']);
    const s = scene();
    await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d);
    const lines = journal(parent).split('\n').filter((l) => /créneau libre rempli par/.test(l));
    const filled = s.played.filter((p) => p !== 'a:L1');
    expect(lines).toHaveLength(filled.length);
    for (const f of filled) expect(lines.filter((l) => l.includes(`rempli par ${f}`))).toHaveLength(1);
  });
});
