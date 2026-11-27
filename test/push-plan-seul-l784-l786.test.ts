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

  it('R12 (revue r1, m4 b) — un renommage src/x.ts → .cadence/x.ts qui cite un lot ouvert reste à relire (la suppression de src/x.ts est du code)', async () => {
    const { dir } = await project();
    await cli(dir, '', 'add', 'Cache');
    await cli(dir, '', 'start', 'L1');
    git(dir, 'add', '-A');
    const base = change(dir, { 'src/x.ts': 'export const x = 1;\n' }, 'chore: x');
    mkdirSync(join(dir, '.cadence'), { recursive: true });
    git(dir, 'mv', 'src/x.ts', '.cadence/x.ts');
    const a = change(dir, {}, 'feat(L1): x rangé');
    const r = await prePush(dir, push(a, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain(`L1 (${a.slice(0, 7)})`);
  });

  it('R13 (revue r1, m4 c) — une fusion qui cite un lot ouvert et dont le second parent porte du code non relu : refusée', async () => {
    const { dir } = await project();
    await cli(dir, '', 'add', 'Cache');
    await cli(dir, '', 'start', 'L1');
    git(dir, 'add', '-A');
    const base = change(dir, demande(5), 'plan: L1 démarré (D-5)');
    git(dir, 'checkout', '-qb', 'cote');
    change(dir, { 'src/cote.ts': '1\n' }, 'wip');
    git(dir, 'checkout', '-q', '-');
    change(dir, demande(6), 'plan: D-6');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', '--no-ff', '-m', 'fix(L1): fusion de cote', 'cote');
    const m = head(dir);
    const r = await prePush(dir, push(m, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain('L1');
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

  it('R9 — gate.readsPlan déclaré : le plan seul hérite comme avant (L432) ; un autre fichier de .cadence/ que le registre exige sa porte', async () => {
    const { dir, base } = project(true);
    const seul = change(dir, { '.cadence/raf.yaml': 'lots: []\n' }, 'plan: L5 terminé');
    expect((await prePush(dir, push(seul, base))).code).toBe(0);
    const p = change(dir, { '.cadence/docs-ok.yaml': 'ok: []\n' }, 'plan: docs-ok');
    const r = await prePush(dir, push(p, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain('aucun verdict de la porte pour ce sha');
  });

  // L920 : « registre: D-4 livrée » (un seul .cadence/demandes/D-4.json) refusé au push dans ol-companion le 27-11, toute la porte à rejouer pour un JSON.
  // Le registre suit la règle du plan seul, avec ou sans gate.readsPlan, et sans CADENCE_PUSH_UNGATED.
  for (const readsPlan of [false, true]) {
    const cas = readsPlan ? 'gate.readsPlan déclaré' : 'sans gate.readsPlan';
    it(`R14 (L920, ${cas}) — un commit de registre seul au-dessus d'un sha à porte verte : le push passe`, async () => {
      const { dir, base } = project(readsPlan);
      const p = change(dir, demande(4), 'registre: D-4 livrée');
      const r = await prePush(dir, push(p, base));
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
    });

    it(`R15 (L920, ${cas}) — un commit registre + code : la porte reste due`, async () => {
      const { dir, base } = project(readsPlan);
      const p = change(dir, { ...demande(4), 'src/a.ts': '2\n' }, 'registre: D-4 livrée');
      const r = await prePush(dir, push(p, base));
      expect(r.code).toBe(3);
      expect(r.err).toContain('aucun verdict de la porte pour ce sha');
    });

    it(`R16 (L920, ${cas}) — plan + registre ensemble, puis un registre seul empilé : le push passe`, async () => {
      const { dir, base } = project(readsPlan);
      change(dir, { '.cadence/raf.yaml': 'lots: []\n', ...demande(4) }, 'plan: L5 terminé (D-4)');
      const p = change(dir, demande(5), 'registre: D-5 notée');
      const r = await prePush(dir, push(p, base));
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
    });
  }

  it('R17 (L920) — un fichier qui ressemble au registre sans en être (.cadence/demandes/archive/D-1.json, D-1.md) n\'hérite pas sous gate.readsPlan', async () => {
    const { dir, base } = project(true);
    for (const file of ['.cadence/demandes/archive/D-1.json', '.cadence/demandes/D-1.md']) {
      const p = change(dir, { [file]: '{}\n' }, 'registre: autre');
      const r = await prePush(dir, push(p, base));
      expect(r.code).toBe(3);
    }
  });

  it('R10 (revue r1, m1) — plan.onWrite.files lu au sha jugé : une sortie déclarée dans l\'arbre courant seulement n\'hérite pas du verdict', async () => {
    const { dir, base } = project();
    // cadence.yaml de l'arbre (non commité) déclare src/a.ts comme sortie de plan.onWrite ; le sha vert ne le déclarait pas.
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: "true"\nplan:\n  path: .cadence/raf.yaml\n  onWrite: { command: \'true\', files: [public/plan.json, src/a.ts] }\n');
    git(dir, 'add', 'src/a.ts');
    const p = change(dir, { 'src/a.ts': '2\n' }, 'plan: régénéré');
    const r = await prePush(dir, push(p, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain('aucun verdict de la porte pour ce sha');
  });

  it('R11 (revue r1, m1) — la sortie déclarée au sha jugé hérite toujours, même quand l\'arbre courant ne la déclare plus', async () => {
    const { dir, base } = project();
    const p = change(dir, { 'public/plan.json': '{"lots":[]}\n' }, 'plan: régénéré');
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: "true"\nplan:\n  path: .cadence/raf.yaml\n');
    const r = await prePush(dir, push(p, base));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });
});
