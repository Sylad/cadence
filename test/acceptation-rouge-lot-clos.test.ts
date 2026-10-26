import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { lockViolations, sealAcceptation } from '../src/orchestrate/accept.js';
import { orchestrate, type OrchestrateIo } from '../src/orchestrate/command.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, git, reviewReport } from './orchestrate-harness.js';
import { DIR, ecritAcceptation } from './accept-helpers.js';
import { gitRepo, removeDryRunBriefs, tempDir } from './helpers.js';

// L366 : un lot clos à la main (raf done) avec acceptation-<lot>.json à vert: false bloque les vagues suivantes du dépôt.
// cadence spec green <lot> pose vert: true comme le cycle ; raf done refuse un lot à vert: false ; le dry-run le signale.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const commitPaths = (repo: string, message: string, ...paths: string[]) => {
  git(repo, 'add', '--', ...paths);
  git(repo, 'commit', '-q', '-m', message, '--', ...paths);
};

function cli(repo: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-26', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-26T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt dont L1 a une acceptation scellée à vert: false ; L1 est en cours (`statut: 'doing'`), clos (`done`, à la main) ou à faire. `accept` : la commande dédiée du cadence.yaml. */
function depot(o: { statut?: 'todo' | 'doing' | 'done'; accept?: string | string[]; vert?: boolean; parent?: string } = {}) {
  const repo = gitRepo(o.parent);
  const a = ecritAcceptation(repo);
  sealAcceptation(repo, a.json);
  commitPaths(repo, 'test(L1): acceptation scellée', a.json);
  if (o.vert) {
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    writeFileSync(join(repo, a.json), `${JSON.stringify({ ...doc, vert: true }, null, 2)}\n`);
    commitPaths(repo, 'chore(L1): acceptation verte', a.json);
  }
  cli(repo, {}, 'init', '--project', 'demo');
  cli(repo, {}, 'add', 'Lot un');
  cli(repo, {}, 'add', 'Lot deux');
  const statut = o.statut ?? 'done';
  if (statut !== 'todo') cli(repo, {}, 'start', 'L1');
  if (statut === 'done') cli(repo, {}, 'done', 'L1', '--force');
  if (o.accept !== undefined) writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  precheck: false\n  accept: ${JSON.stringify(o.accept)}\n`);
  commitPaths(repo, 'plan: L1', '.cadence/raf.yaml', '.cadence/notes/.gitkeep', '.gitignore', ...(o.accept !== undefined ? ['cadence.yaml'] : []));
  return { repo, a };
}

const vertDe = (repo: string, json: string) => JSON.parse(readFileSync(join(repo, json), 'utf8')).vert;

describe('cadence spec green <lot> : poser vert: true sur un lot clos à la main (L366)', () => {
  it('R1 — la commande d\'acceptation verte pose vert: true et le commite en citant le lot, l\'arbre reste propre et le verrou muet', () => {
    const { repo, a } = depot({ accept: 'true' });
    const r = cli(repo, {}, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(vertDe(repo, a.json)).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s')).toMatch(/^chore\(L1\): acceptation verte, vert: true posé par cadence spec green/);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)).toEqual([a.json]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(r.out).toContain(a.json);
    expect(lockViolations(repo, DIR, git(repo, 'rev-parse', 'HEAD'))).toEqual([]);
  });

  it('R2 — la commande reçoit CADENCE_ACCEPTATION (chemin du fichier) et {acceptation} est substitué, comme dans le cycle', () => {
    const { repo, a } = depot({ accept: 'test "$CADENCE_ACCEPTATION" = "{acceptation}" && test -f "{acceptation}"' });
    const r = cli(repo, {}, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(vertDe(repo, a.json)).toBe(true);
  });

  it('R3 — commande rouge : code 1, la fin de sa sortie est montrée, vert reste false et rien n\'est commité', () => {
    const { repo, a } = depot({ accept: 'echo "boom visible"; exit 3' });
    const before = git(repo, 'rev-parse', 'HEAD');
    const r = cli(repo, {}, 'spec', 'green', 'L1');
    expect(r.code).toBe(1);
    expect(r.err).toContain('encore rouges');
    expect(r.err).toContain('code 3');
    expect(r.err).toContain('boom visible');
    expect(vertDe(repo, a.json)).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('R4 — déjà vert : rien à faire, aucun commit, la commande n\'est pas lancée', () => {
    const { repo } = depot({ accept: 'exit 9', vert: true });
    const before = git(repo, 'rev-parse', 'HEAD');
    const r = cli(repo, {}, 'spec', 'green', 'L1');
    expect(r.code).toBe(0);
    expect(r.out).toContain('déjà vert');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('R5 — sans orchestrate.accept au cadence.yaml : refus qui nomme la clé', () => {
    const { repo, a } = depot();
    const r = cli(repo, {}, 'spec', 'green', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestrate.accept');
    expect(vertDe(repo, a.json)).toBe(false);
  });

  it('R6 — un lot à faire est refusé ; un lot en cours mené à la main (hors vague) passe comme un lot clos', () => {
    const todo = depot({ statut: 'todo', accept: 'true' });
    const r = cli(todo.repo, {}, 'spec', 'green', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain("L1 n'est pas commencé (todo)");
    expect(vertDe(todo.repo, todo.a.json)).toBe(false);
    const doing = depot({ statut: 'doing', accept: 'true' });
    expect(cli(doing.repo, {}, 'spec', 'green', 'L1').code).toBe(0);
    expect(vertDe(doing.repo, doing.a.json)).toBe(true);
  });

  it('R7 — lot sans acceptation sous spec.dir : refus qui le dit ; sans argument : usage', () => {
    const { repo } = depot({ accept: 'true' });
    cli(repo, {}, 'start', 'L2');
    const r = cli(repo, {}, 'spec', 'green', 'L2');
    expect(r.code).toBe(2);
    expect(r.err).toContain('L2 : aucune acceptation');
    const u = cli(repo, {}, 'spec', 'green');
    expect(u.code).toBe(2);
    expect(u.err).toContain('usage : cadence spec green <lot>');
  });

  it('R8 — refusé pendant une vague orchestrée : c\'est le travail du lead, hors session', () => {
    const { repo, a } = depot({ accept: 'true' });
    const r = cli(repo, { CADENCE_ORCHESTRATED: '2026-10-26-1950' }, 'spec', 'green', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('spec green refusé pendant une vague orchestrée');
    expect(vertDe(repo, a.json)).toBe(false);
  });

  it('R9 — un fichier listé sous la racine d\'aucune commande : refus, rien n\'est lancé', () => {
    const { repo, a } = depot({ accept: ['cd front && touch ../ran'] });
    const r = cli(repo, {}, 'spec', 'green', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('sous la racine d\'aucune commande');
    expect(existsSync(join(repo, 'ran'))).toBe(false);
    expect(vertDe(repo, a.json)).toBe(false);
  });

  it('R17 — scénario de l\'issue #18 : tests mis au point après le commit rouge, spec green les rescelle (journal resceaux) et le verrou d\'un lot suivant est muet', () => {
    const { repo, a } = depot({ accept: 'true' });
    const test = JSON.parse(readFileSync(join(repo, a.json), 'utf8')).fichiers[0] as string;
    writeFileSync(join(repo, test), `${readFileSync(join(repo, test), 'utf8')}\n// mise au point\n`);
    commitPaths(repo, 'fix(L1): mise au point des tests', test);
    const avant = git(repo, 'rev-parse', 'HEAD');
    expect(lockViolations(repo, DIR, avant, { lot: 'L2', lotBase: avant }).join('\n')).toContain('premier commit fautif');
    const r = cli(repo, {}, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    expect(doc.vert).toBe(true);
    expect(doc.empreintes[test]).toBe(git(repo, 'hash-object', '--', test).trim());
    expect(doc.resceaux).toHaveLength(1);
    expect(doc.resceaux[0]).toMatchObject({ test, apres: doc.empreintes[test] });
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)).toEqual([a.json]);
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(lockViolations(repo, DIR, head, { lot: 'L2', lotBase: head })).toEqual([]);
  });

  /** Un hook commit-msg comme commitlint config-conventional : refuse un en-tête de plus de 100 caractères (header-max-length) et une ligne de corps de plus de 100 (body-max-line-length). */
  const hookLongueur = (repo: string) => {
    const hook = join(repo, '.git', 'hooks', 'commit-msg');
    writeFileSync(hook, '#!/bin/sh\nn=$(head -n1 "$1" | awk \'{ print length($0) }\')\nif [ "$n" -gt 100 ]; then echo "✖   header must not be longer than 100 characters, current length is $n [header-max-length]" >&2; exit 1; fi\nif awk \'length($0) > 100 { f = 1 } END { exit !f }\' "$1"; then echo "✖   body\'s lines must not be longer than 100 characters [body-max-line-length]" >&2; exit 1; fi\n');
    chmodSync(hook, 0o755);
  };
  /** L1 clos, un test mis au point après le commit rouge (le cas de l'issue #18) : spec green doit le resceller. */
  const depotMisAuPoint = (repo: string, a: { json: string }) => {
    const test = JSON.parse(readFileSync(join(repo, a.json), 'utf8')).fichiers[0] as string;
    writeFileSync(join(repo, test), `${readFileSync(join(repo, test), 'utf8')}\n// mise au point\n`);
    commitPaths(repo, 'fix(L1): mise au point des tests', test);
    return test;
  };

  it('R19 — le sujet du commit reste court et fixe quand des tests sont rescellés : un hook qui borne l\'en-tête à 100 caractères l\'accepte, la liste est dans le corps', () => {
    const { repo, a } = depot({ accept: 'true' });
    const test = depotMisAuPoint(repo, a);
    hookLongueur(repo);
    const r = cli(repo, {}, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(vertDe(repo, a.json)).toBe(true);
    const sujet = git(repo, 'log', '-1', '--format=%s');
    expect(sujet.length).toBeLessThanOrEqual(72);
    expect(sujet).toBe('chore(L1): acceptation verte, vert: true posé par cadence spec green');
    expect(sujet).not.toContain(test);
    expect(git(repo, 'log', '-1', '--format=%b')).toContain(`- ${test}`);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)).toEqual([a.json]);
    expect(r.out).toContain(test);
  });

  it('R19 — avec un gabarit plan.commit au cadence.yaml, le sujet vient du gabarit (comme tout commit écrit par cadence) et la liste reste dans le corps', () => {
    const { repo, a } = depot({ accept: 'true' });
    writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  precheck: false\n  accept: "true"\nplan:\n  commit: "ci({lot}): {action}"\n`);
    commitPaths(repo, 'chore: gabarit', 'cadence.yaml');
    const test = depotMisAuPoint(repo, a);
    hookLongueur(repo);
    const r = cli(repo, {}, 'spec', 'green', 'L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('ci(L1): acceptation verte, vert: true posé par cadence spec green');
    expect(git(repo, 'log', '-1', '--format=%b')).toContain(`- ${test}`);
  });

  it('R19 — sans test rescellé, pas de corps : le commit ne porte que son sujet', () => {
    const { repo } = depot({ accept: 'true' });
    expect(cli(repo, {}, 'spec', 'green', 'L1').code).toBe(0);
    expect(git(repo, 'log', '-1', '--format=%b').trim()).toBe('');
  });

  it('R18 — un test listé modifié dans l\'arbre de travail sans être commité : spec green refuse, rien n\'est lancé ni commité', () => {
    const { repo, a } = depot({ accept: 'touch ran' });
    const test = JSON.parse(readFileSync(join(repo, a.json), 'utf8')).fichiers[0] as string;
    writeFileSync(join(repo, test), `${readFileSync(join(repo, test), 'utf8')}\n// non commité\n`);
    const avant = git(repo, 'rev-parse', 'HEAD');
    const r = cli(repo, {}, 'spec', 'green', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain(test);
    expect(r.err).toContain('sans être commités');
    expect(existsSync(join(repo, 'ran'))).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(avant);
    expect(vertDe(repo, a.json)).toBe(false);
  });
});

describe('raf done d\'un lot à vert: false (L366)', () => {
  it('R10 — refuse, nomme le fichier et la commande qui y remédie, le lot reste en cours', () => {
    const { repo, a } = depot({ statut: 'doing' });
    const r = cli(repo, {}, 'done', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain(a.json);
    expect(r.err).toContain('vert: false');
    expect(r.err).toContain('cadence spec green L1');
    expect(r.err).toContain('--force');
    expect(Plan.load(join(repo, '.cadence/raf.yaml')).lot('L1').status).toBe('doing');
  });

  it('R11 — avec --force : avertit sur la sortie d\'erreur et clôt', () => {
    const { repo } = depot({ statut: 'doing' });
    const r = cli(repo, {}, 'done', 'L1', '--force');
    expect(r.code).toBe(0);
    expect(r.err).toContain('vert: false');
    expect(r.err).toContain('cadence spec green L1');
    expect(r.out).toContain('L1 → done');
  });

  it('R12 — acceptation verte, ou lot sans acceptation : se clôt sans avertissement', () => {
    const vert = depot({ statut: 'doing', vert: true });
    const a = cli(vert.repo, {}, 'done', 'L1');
    expect(a.code).toBe(0);
    expect(a.err).toBe('');
    const sans = depot({ statut: 'doing' });
    cli(sans.repo, {}, 'start', 'L2');
    const b = cli(sans.repo, {}, 'done', 'L2');
    expect(b.code).toBe(0);
    expect(b.err).toBe('');
  });

  it('R13 — parcours : refus, spec green, puis le done passe sans --force', () => {
    const { repo, a } = depot({ statut: 'doing', accept: 'true' });
    expect(cli(repo, {}, 'done', 'L1').code).toBe(2);
    expect(cli(repo, {}, 'spec', 'green', 'L1').code).toBe(0);
    const r = cli(repo, {}, 'done', 'L1');
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(vertDe(repo, a.json)).toBe(true);
  });
});

describe('orchestrate --dry-run : l\'acceptation rouge d\'un lot clos (L366)', () => {
  async function dry(parent: string, ...lots: string[]) {
    const out: string[] = [];
    const io: OrchestrateIo = { cwd: parent, env: { RAF_TODAY: '2026-10-26' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-26T10:00:00') };
    const deps = { claude: async () => claudeOut(reviewReport()), claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
    const code = await orchestrate([...lots, '--dry-run'], io, deps);
    const text = out.join('\n');
    removeDryRunBriefs(text);
    return { code, out, text };
  }

  it('R14 — un lot clos à vert: false est signalé une fois par dépôt : le lot, le fichier, la conséquence et la commande', async () => {
    const parent = tempDir();
    const { repo, a } = depot({ accept: 'true', parent });
    cli(repo, {}, 'add', 'Lot trois');
    commitPaths(repo, 'plan: L3', '.cadence/raf.yaml');
    const r = await dry(parent, 'depot:L2', 'depot:L3');
    expect(r.code).toBe(0);
    const lines = r.out.filter((l) => l.includes('acceptation rouge'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('L1');
    expect(lines[0]).toContain(a.json);
    expect(lines[0]).toContain('verrou des tests d\'acceptation');
    expect(lines[0]).toContain('cadence spec green L1');
  });

  it('R15 — rien à signaler : acceptation verte, lot encore en cours ou sans acceptation', async () => {
    for (const o of [{ vert: true }, { statut: 'doing' as const }]) {
      const parent = tempDir();
      depot({ ...o, parent });
      const r = await dry(parent, 'depot:L2');
      expect(r.text).not.toContain('acceptation rouge');
    }
  });
});

describe('documentation de L366', () => {
  const lire = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8');

  it('R16 — le README de l\'usage (docs/orchestrate.md), docs/raf.md et le CHANGELOG décrivent spec green, le refus de done et la ligne du dry-run', () => {
    expect(lire('docs/orchestrate.md')).toContain('cadence spec green');
    expect(lire('docs/orchestrate.md')).toContain('acceptation rouge');
    expect(lire('docs/raf.md')).toContain('cadence spec green');
    const changelog = lire('CHANGELOG.md');
    expect(changelog).toContain('L366');
    expect(changelog).toContain('cadence spec green');
  });
});
