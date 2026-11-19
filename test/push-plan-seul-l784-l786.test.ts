// L784 et L786 : deux faux refus du hook pre-push vécus plusieurs fois par jour.
// L784 : un commit de plan seul (création d'un lot et d'une demande : .cadence/raf.yaml et .cadence/demandes/D-n.json) qui cite des lots ouverts dans son
// sujet était compté comme du code de ces lots sans revue (43c4083 à la publication de 2.0.16, puis 365cef1/f6d2727 sur un autre dépôt le 19-11).
// L786 : sous un commit de plan seul de plusieurs fichiers (plan + demande, plan + sortie de plan.onWrite), le sha à porte verte ne prêtait plus son verdict.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { recordVerdict } from '../src/gate-verdict.js';
import { cleanupTempDirs, commit, gitRepo } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const head = (dir: string) => git(dir, 'rev-parse', 'HEAD');
const push = (local: string, remote: string) => `refs/heads/main ${local} refs/heads/main ${remote}\n`;

async function cli(dir: string, stdin: string, ...argv: string[]) {
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-19' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-11-19T10:00:00'), stdin: () => stdin });
  return { code, err: err.join('\n') };
}
const prePush = (dir: string, stdin: string) => cli(dir, stdin, 'hook', 'pre-push', 'origin');

/** Écrit chaque fichier (chemin → texte) et commite le tout sous `message`. */
function change(dir: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
    git(dir, 'add', file);
  }
  commit(dir, message, '2026-11-19T10:00:00');
  return head(dir);
}

const demande = (n: number) => ({ [`.cadence/demandes/D-${n}.json`]: `${JSON.stringify({ id: `D-${n}`, texte: 'x', etat: 'ouverte' })}\n` });

describe('hook pre-push, revue : un commit de plan seul qui cite des lots ouverts n\'est pas du code de ces lots (L784)', () => {
  /** Plan natif, revue exigée, plan.onWrite qui régénère public/plan.json ; un premier lot relu et poussé. */
  async function project(onWrite = true) {
    const dir = gitRepo();
    await cli(dir, '', 'init', '--no-hook');
    if (onWrite) appendFileSync(join(dir, 'cadence.yaml'), "\nplan:\n  path: .cadence/raf.yaml\n  onWrite: { command: 'mkdir -p public && cp .cadence/raf.yaml public/plan.json', files: [public/plan.json] }\n");
    await cli(dir, '', 'review', 'enable');
    git(dir, 'add', '-A');
    commit(dir, 'init', '2026-11-19T09:00:00');
    return { dir, base: head(dir) };
  }

  it('R1 — création de deux lots et d\'une demande (.cadence/raf.yaml + .cadence/demandes/D-28.json), sujet qui cite les lots : le push passe (43c4083)', async () => {
    const { dir, base } = await project(false);
    await cli(dir, '', 'add', 'Cache');
    await cli(dir, '', 'add', 'Légende');
    git(dir, 'add', '-A');
    const a = change(dir, demande(28), 'plan: L1 et L2 ouverts (D-28) ; L0 revu et terminé');
    expect(git(dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', a).split('\n').sort()).toEqual(['.cadence/demandes/D-28.json', '.cadence/raf.yaml']);
    const r = await prePush(dir, push(a, base));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });

  it('R2 — un seul commit plan + demande + sortie de plan.onWrite, lot démarré non relu : le push passe (365cef1)', async () => {
    const { dir, base } = await project();
    await cli(dir, '', 'add', 'Cache');
    await cli(dir, '', 'start', 'L1');
    git(dir, 'add', '-A');
    const files = git(dir, 'diff', '--cached', '--name-only');
    expect(files.split('\n').sort()).toEqual(['.cadence/raf.yaml', 'public/plan.json']);
    const a = change(dir, demande(3), 'plan: L1 créé (D-3)');
    expect(git(dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', a).split('\n').sort()).toEqual(['.cadence/demandes/D-3.json', '.cadence/raf.yaml', 'public/plan.json']);
    const r = await prePush(dir, push(a, base));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });

  it('R3 — le même commit qui touche aussi du code : refusé, le lot et le commit sont nommés', async () => {
    const { dir, base } = await project();
    await cli(dir, '', 'add', 'Cache');
    await cli(dir, '', 'start', 'L1');
    git(dir, 'add', '-A');
    const a = change(dir, { ...demande(3), 'src/a.ts': '1\n' }, 'feat(L1): cache');
    const r = await prePush(dir, push(a, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain(`L1 (${a.slice(0, 7)})`);
  });

  it('R4 — la configuration n\'est pas du plan : un commit .cadence/ + cadence.yaml (hors clé plan:) qui cite un lot reste à relire', async () => {
    const { dir, base } = await project();
    await cli(dir, '', 'add', 'Cache');
    await cli(dir, '', 'start', 'L1');
    git(dir, 'add', '-A');
    appendFileSync(join(dir, 'cadence.yaml'), 'hook:\n  autostart: warn\n');
    git(dir, 'add', 'cadence.yaml');
    const a = change(dir, demande(4), 'chore(L1): hook du projet');
    const r = await prePush(dir, push(a, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain(`L1 (${a.slice(0, 7)})`);
  });
});

describe('hook pre-push, porte : un commit de plan seul au-dessus d\'un sha à porte verte reprend son verdict (L786)', () => {
  /** Dépôt dont la porte est déclarée (`orchestrate.test`), plan.onWrite qui écrit public/plan.json ; `readsPlan` en option. Le sha `vert` a un verdict vert. */
  function project(readsPlan = false) {
    const dir = gitRepo();
    const config = `orchestrate:\n  test: "true"\n${readsPlan ? '  gate: { readsPlan: true }\n' : ''}plan:\n  path: .cadence/raf.yaml\n  onWrite: { command: 'true', files: [public/plan.json] }\n`;
    const base = change(dir, { 'cadence.yaml': config, 'src/a.ts': '0\n' }, 'init');
    const vert = change(dir, { 'src/a.ts': '1\n' }, 'feat: travail intégré par cadence run');
    recordVerdict(dir, vert, 0, new Date('2026-11-19T10:00:00'));
    return { dir, base, vert };
  }

  it('R5 — le sha intégré lui-même, verdict noté : le push passe', async () => {
    const { dir, base, vert } = project();
    expect((await prePush(dir, push(vert, base))).code).toBe(0);
  });

  it('R6 — plan + demande au-dessus (cluster-sante a3cc356 suivi d\'un commit de plan) : le push passe sans nouvelle porte', async () => {
    const { dir, base } = project();
    const p = change(dir, { '.cadence/raf.yaml': 'lots: []\n', ...demande(1) }, 'plan: L5 terminé (D-1)');
    const r = await prePush(dir, push(p, base));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });

  it('R7 — plan + sortie de plan.onWrite, puis une demande seule, empilés : le push passe', async () => {
    const { dir, base } = project();
    change(dir, { '.cadence/raf.yaml': 'lots: []\n', 'public/plan.json': '{}\n' }, 'plan: L5 terminé');
    const p = change(dir, demande(2), 'plan: D-2 notée');
    expect((await prePush(dir, push(p, base))).code).toBe(0);
  });

  it('R8 — un commit qui touche cadence.yaml n\'hérite pas : la porte est exigée', async () => {
    const { dir, base } = project();
    const p = change(dir, { 'cadence.yaml': 'orchestrate:\n  test: "false"\n', ...demande(1) }, 'plan: porte changée');
    const r = await prePush(dir, push(p, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain('aucun verdict de la porte pour ce sha');
  });

  it('R9 — gate.readsPlan déclaré : un commit plan + demande exige sa porte ; le plan seul hérite comme avant (L432)', async () => {
    const { dir, base } = project(true);
    const seul = change(dir, { '.cadence/raf.yaml': 'lots: []\n' }, 'plan: L5 terminé');
    expect((await prePush(dir, push(seul, base))).code).toBe(0);
    const p = change(dir, demande(1), 'plan: D-1');
    const r = await prePush(dir, push(p, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain('aucun verdict de la porte pour ce sha');
  });
});
