import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { verdictKey } from '../src/push-review.js';
import { cleanupTempDirs, commit, gitRepo } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const ZERO = '0'.repeat(40);
const head = (dir: string) => git(dir, 'rev-parse', 'HEAD');
const push = (local: string, remote = ZERO, ref = 'refs/heads/main') => `${ref} ${local} ${ref} ${remote}\n`;

async function cli(dir: string, stdin: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-17', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-17T10:00:00'), stdin: () => stdin });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const prePush = (dir: string, stdin: string, env: Record<string, string> = {}) => cli(dir, stdin, env, 'hook', 'pre-push', 'origin');

/** Un commit qui touche un fichier (un commit vide n'a pas de fichier : ni plan, ni version). */
function change(dir: string, file: string, text: string, message: string): string {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  commit(dir, message, '2026-11-17T10:00:00');
  return head(dir);
}

/** Plan natif, revue de code exigée, deux lots démarrés ; `base` : le commit de départ (déjà sur le distant). */
async function nativeProject(review = true) {
  const dir = gitRepo();
  await cli(dir, '', {}, 'init', '--no-hook');
  if (review) await cli(dir, '', {}, 'review', 'enable');
  await cli(dir, '', {}, 'add', 'Cache');
  await cli(dir, '', {}, 'add', 'Légende');
  await cli(dir, '', {}, 'start', 'L1');
  await cli(dir, '', {}, 'start', 'L2');
  const base = change(dir, 'README.md', 'x\n', 'init');
  return { dir, base };
}

describe('hook pre-push : un commit de lot sans verdict de revue postérieur est refusé (L766) — plan natif', () => {
  it('R1 — un commit de lot non relu : refus (code 3) qui nomme le commit, le lot, raf review et la variable qui passe outre', async () => {
    const { dir, base } = await nativeProject();
    const a = change(dir, 'src/a.ts', '1\n', 'feat(L1): cache');
    const r = await prePush(dir, push(a, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain(`L1 (${a.slice(0, 7)})`);
    expect(r.err).toContain('raf review L1 "verdict"');
    expect(r.err).toContain('CADENCE_PUSH_UNREVIEWED=1');
  });

  it('R2 — relu par raf review : le push passe', async () => {
    const { dir, base } = await nativeProject();
    const a = change(dir, 'src/a.ts', '1\n', 'feat(L1): cache');
    expect((await cli(dir, '', {}, 'review', 'L1', 'conforme')).code).toBe(0);
    const r = await prePush(dir, push(a, base));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });

  it('R3 — lot relu puis recommité : seul le commit d\'après la revue est nommé, le push est refusé', async () => {
    const { dir, base } = await nativeProject();
    const a = change(dir, 'src/a.ts', '1\n', 'feat(L1): cache');
    await cli(dir, '', {}, 'review', 'L1', 'conforme');
    const b = change(dir, 'src/a.ts', '2\n', 'fix(L1): cache vidé');
    const r = await prePush(dir, push(b, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain(`L1 (${b.slice(0, 7)})`);
    expect(r.err).not.toContain(`${a.slice(0, 7)})`);
  });

  it('R4 — push du sha relu seul permis, même si un commit non relu est au-dessus ; le refus du sommet propose ce sha', async () => {
    const { dir, base } = await nativeProject();
    const a = change(dir, 'src/a.ts', '1\n', 'feat(L1): cache');
    await cli(dir, '', {}, 'review', 'L1', 'conforme');
    const b = change(dir, 'src/b.ts', '1\n', 'feat(L2): légende');
    expect((await prePush(dir, push(a, base))).code).toBe(0);
    const top = await prePush(dir, push(b, base));
    expect(top.code).toBe(3);
    expect(top.err).toContain(`L2 (${b.slice(0, 7)})`);
    expect(top.err).toContain(`git push origin ${a.slice(0, 7)}:main`);
  });

  it('R5 — commits de plan, de version et sans lot passent', async () => {
    const { dir, base } = await nativeProject();
    git(dir, 'add', '.cadence');
    commit(dir, 'plan: L1 démarré', '2026-11-17T10:00:00');
    change(dir, 'package.json', '{"name":"p","version":"1.0.0"}\n', 'chore: package');
    const from = head(dir);
    const v = change(dir, 'package.json', '{"name":"p","version":"1.0.1"}\n', 'release(L1): 1.0.1');
    expect((await prePush(dir, push(v, from))).code).toBe(0);
    const orphan = change(dir, 'notes.txt', 'n\n', 'docs: notes');
    expect((await prePush(dir, push(orphan, base))).code).toBe(0);
  });

  it('R6 — CADENCE_PUSH_UNREVIEWED=1 laisse passer et le dit sur stderr', async () => {
    const { dir, base } = await nativeProject();
    const a = change(dir, 'src/a.ts', '1\n', 'feat(L1): cache');
    const r = await prePush(dir, push(a, base), { CADENCE_PUSH_UNREVIEWED: '1' });
    expect(r.code).toBe(0);
    expect(r.err).toContain('push passé outre');
    expect(r.err).toContain('CADENCE_PUSH_UNREVIEWED=1 est posée');
  });

  it('R7 — sans revue exigée (pas de reviewSince), une branche supprimée ou un tag : rien n\'est refusé', async () => {
    const off = await nativeProject(false);
    const a = change(off.dir, 'src/a.ts', '1\n', 'feat(L1): cache');
    expect((await prePush(off.dir, push(a, off.base))).code).toBe(0);
    const on = await nativeProject();
    const b = change(on.dir, 'src/a.ts', '1\n', 'feat(L1): cache');
    expect((await prePush(on.dir, `refs/heads/x ${ZERO} refs/heads/x ${on.base}\n`)).code).toBe(0);
    expect((await prePush(on.dir, push(b, ZERO, 'refs/tags/v1'))).code).toBe(0);
  });

  it('R8 — branche neuve : seuls les commits qu\'aucune réf du distant n\'a déjà sont jugés', async () => {
    const { dir } = await nativeProject();
    const a = change(dir, 'src/a.ts', '1\n', 'feat(L1): cache');
    git(dir, 'update-ref', 'refs/remotes/origin/main', a);
    const b = change(dir, 'src/b.ts', '1\n', 'feat(L2): légende');
    const r = await prePush(dir, push(b, ZERO, 'refs/heads/neuve'));
    expect(r.code).toBe(3);
    expect(r.err).toContain(`L2 (${b.slice(0, 7)})`);
    expect(r.err).not.toContain('L1 (');
  });
});

describe('hook pre-push (L766) — plan en lecture seule, verdict noté par orchestrate.verdict', () => {
  const PLAN = 'suivi/plan.yaml';
  const planText = (notes: string[]) => `taches:\n  - { code: Q-LEG10, titre: Légende, etat: en_cours${notes.length ? `, journal: [${notes.map((n) => `{ date: 2026-11-17, text: "${n}" }`).join(', ')}]` : ''} }\n`;

  function readonlyProject(verdict = 'python3 scripts/raf.py note {lot} "revue de code : {verdict}"') {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), `plan:\n  path: ${PLAN}\n  since: 2026-11-01\n  lots: taches\n  idPattern: 'Q-[A-Z]+\\d+'\n  fields: { id: code, title: titre, status: etat, notes: journal }\n  statuses: { todo: prevu, doing: en_cours, done: livre }\norchestrate:\n  verdict: ${JSON.stringify(verdict)}\n`);
    const base = change(dir, PLAN, planText([]), 'init');
    return { dir, base };
  }

  it('R9 — Q-LEG10 intégré mais non relu : refus qui nomme le commit, le lot et la commande du projet', async () => {
    const { dir, base } = readonlyProject();
    const a = change(dir, 'src/legende.ts', '1\n', 'feat(Q-LEG10): légende');
    const r = await prePush(dir, push(a, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain(`Q-LEG10 (${a.slice(0, 7)})`);
    expect(r.err).toContain('python3 scripts/raf.py note Q-LEG10 "revue de code : …"');
  });

  it('R10 — une note de verdict posée après le commit : le push passe, y compris celui du sha seul ; une autre note ne compte pas', async () => {
    const { dir, base } = readonlyProject();
    const a = change(dir, 'src/legende.ts', '1\n', 'feat(Q-LEG10): légende');
    change(dir, PLAN, planText(['démarré par cadence']), 'plan: Q-LEG10 note');
    expect((await prePush(dir, push(a, base))).code).toBe(3);
    const noted = change(dir, PLAN, planText(['démarré par cadence', 'revue de code : conforme']), 'plan: Q-LEG10 revue de code notée');
    expect((await prePush(dir, push(noted, base))).code).toBe(0);
    expect((await prePush(dir, push(a, base))).code).toBe(0);
  });

  it('R11 — relu puis recommité : le commit d\'après la note est refusé', async () => {
    const { dir, base } = readonlyProject();
    const a = change(dir, 'src/legende.ts', '1\n', 'feat(Q-LEG10): légende');
    change(dir, PLAN, planText(['revue de code : conforme']), 'plan: Q-LEG10 revue de code notée');
    const b = change(dir, 'src/legende.ts', '2\n', 'fix(Q-LEG10): légende');
    const r = await prePush(dir, push(b, base));
    expect(r.code).toBe(3);
    expect(r.err).toContain(`Q-LEG10 (${b.slice(0, 7)})`);
    expect(r.err).not.toContain(`${a.slice(0, 7)})`);
  });

  it('R12 — sans clé de verdict lisible dans orchestrate.verdict, rien n\'est exigé', async () => {
    const { dir, base } = readonlyProject('scripts/verdict.sh {lot} {verdict}');
    const a = change(dir, 'src/legende.ts', '1\n', 'feat(Q-LEG10): légende');
    expect((await prePush(dir, push(a, base))).code).toBe(0);
  });
});

describe('verdictKey (L766)', () => {
  it('lit le texte fixe avant {verdict} dans son argument entre guillemets', () => {
    expect(verdictKey('python3 scripts/raf.py note {lot} "revue de code : {verdict}"')).toBe('revue de code :');
    expect(verdictKey("tool note {lot} 'review: {verdict}'")).toBe('review:');
    expect(verdictKey('tool {lot} "{verdict}"')).toBeNull();
    expect(verdictKey('tool {lot} {verdict}')).toBeNull();
    expect(verdictKey(undefined)).toBeNull();
  });
});
