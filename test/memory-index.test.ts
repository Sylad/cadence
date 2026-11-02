import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { SKILLS_DIR } from '../src/skills.js';
import { projectLogDir } from '../src/orchestrate/launch.js';
import { cleanupTempDirs, commit, gitRepo, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

async function cadIn(cwd: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd, env: { RAF_TODAY: '2026-09-28', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-09-28T18:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un projet raf propre (plan commité) ; `yaml` : son cadence.yaml, commité aussi. */
async function project(yaml?: string, dir = gitRepo()) {
  await cadIn(dir, {}, 'init', '--project', 'demo', '--no-hook');
  await cadIn(dir, {}, 'add', 'Cache');
  if (yaml !== undefined) writeFileSync(join(dir, 'cadence.yaml'), yaml);
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-09-20T09:00:00');
  return dir;
}

/** Une mémoire de Claude Code pour `cwd` : son dossier de config et le dossier `memory` du projet. */
function memoryFor(cwd: string) {
  const home = tempDir();
  const memDir = join(projectLogDir(home, cwd), 'memory');
  mkdirSync(memDir, { recursive: true });
  return { home, memDir, index: join(memDir, 'MEMORY.md'), env: { CLAUDE_CONFIG_DIR: home } };
}

/** Un index de `bytes` octets exactement (ASCII) : `dated` entrées datées, un profil, puis du remplissage sans entrée. */
function indexOf(bytes: number, dated = 2): string {
  const lines = ['# Memoire', '- [Profil](profil.md) - qui est l utilisateur'];
  for (let i = 0; i < dated; i++) lines.push(`- **[31-10 : piege ${i}](p${i}.md)** - texte`);
  const head = `${lines.join('\n')}\n`;
  return `${head}# ${'x'.repeat(bytes - head.length - 3)}\n`;
}

const fingerprint = (dir: string): string =>
  createHash('sha1').update(readdirSync(dir, { recursive: true }).map((f) => `${f}:${statSync(join(dir, String(f))).size}`).sort().join('|')).digest('hex');

/** Le rapport de `session close` pour un index fait de `body` (rempli au-delà du seuil par une ligne de titre, jamais comptée). */
async function closeWith(body: string, dir?: string) {
  const d = dir ?? (await project());
  const m = memoryFor(d);
  writeFileSync(m.index, `${body}\n# ${'x'.repeat(12_100)}\n`);
  return (await cadIn(d, m.env, 'session', 'close')).out;
}

/** Le nombre d'entrées datées que la section dit pour `body`, 0 quand elle dit qu'il n'y en a aucune. */
async function datedIn(body: string): Promise<number> {
  const out = await closeWith(body);
  const m = /(\d+) entrée\(s\) datée\(s\)/.exec(out);
  if (!m) expect(out).toContain('aucune entrée datée à regrouper');
  return m ? Number(m[1]) : 0;
}

describe('index mémoire — chemin (R1)', () => {
  /** Une mémoire posée à l'endroit que Claude Code lui donne : le chemin du dossier, chaque caractère non alphanumérique remplacé par « - ». */
  const measured = async (name: string, config?: { CLAUDE_CONFIG_DIR: string; HOME?: string }) => {
    const dir = join(await project(), name);
    mkdirSync(dir, { recursive: true });
    const home = config?.CLAUDE_CONFIG_DIR ?? tempDir();
    const mem = join(home, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'MEMORY.md'), indexOf(13_000));
    return (await cadIn(dir, { CLAUDE_CONFIG_DIR: home }, 'session', 'close')).out;
  };
  it('R1 — chemin /home/u/p/.cadence/x donne -home-u-p--cadence-x', async () => {
    expect(await measured('.cadence/x')).toContain('pèse 13000 octets');
  });
  it('R1 — chemin /home/sylvain_ladoire/p donne -home-sylvain-ladoire-p (« _ » aplati)', async () => {
    expect(await measured('sylvain_ladoire')).toContain('pèse 13000 octets');
  });
  it('R1 — chemin avec espace : « - »', async () => {
    expect(await measured('mon projet')).toContain('pèse 13000 octets');
  });
  it('R1 — CLAUDE_CONFIG_DIR remplace ~/.claude', async () => {
    const dir = await project();
    const home = tempDir();
    const mem = join(home, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'MEMORY.md'), indexOf(13_000));
    const autre = tempDir();
    expect((await cadIn(dir, { CLAUDE_CONFIG_DIR: home, HOME: autre }, 'session', 'close')).out).toContain('pèse 13000 octets');
  });
  it('R1 — CLAUDE_CONFIG_DIR vide : ~/.claude', async () => {
    const dir = await project();
    const home = tempDir();
    const mem = join(home, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'MEMORY.md'), indexOf(13_000));
    expect((await cadIn(dir, { CLAUDE_CONFIG_DIR: '', HOME: home }, 'session', 'close')).out).toContain('pèse 13000 octets');
  });
});

describe('index mémoire — entrées datées (R3)', () => {
  it('R3 — « - **[31-10 : … » est datée', async () => {
    expect(await datedIn('- **[31-10 : piege](a.md)** - x')).toBe(1);
  });
  it('R3 — « - [31-10 …] » et « - **[⚠ 31-10 … » sont datées', async () => {
    expect(await datedIn('- [31-10 piege](a.md) - x\n- **[⚠ 31-10 piege](b.md)** - y')).toBe(2);
  });
  it('R3 — lien vers x_2026_10_13.md sans préfixe jj-mm n’est pas daté', async () => {
    expect(await datedIn('- [Piege](x_2026_10_13.md) - x')).toBe(0);
  });
  it('R3 — « - [Profil](profil.md) » n’est pas datée', async () => {
    expect(await datedIn('- [Profil](profil.md) - qui')).toBe(0);
  });
  it('R3 — ligne de titre « ## … » n’est pas comptée', async () => {
    expect(await datedIn('## 31-10 titre\n31-10 paragraphe')).toBe(0);
  });
  it('R3 — ligne de renvoi « - [Archives datées](memoire-archive_2026_10_30.md) » n’est pas comptée : après regroupement correct, plus d’entrée datée à proposer', async () => {
    expect(await datedIn('# Memoire\n- [Profil](profil.md)\n- [Archives datees](memoire-archive_2026_10_30.md) - entrees du 30-10 au 31-10')).toBe(0);
  });
  it('R3 — fins de ligne CRLF : même nombre qu’en LF', async () => {
    const lf = '- **[31-10 : a](a.md)** - x\n- [Profil](p.md)\n- [01-11 b](b.md)';
    expect(await datedIn(lf.replace(/\n/g, '\r\n'))).toBe(await datedIn(lf));
    expect(await datedIn(lf)).toBe(2);
  });
  it('R3 — un jour ou un mois impossible n’est pas daté', async () => {
    expect(await datedIn('- [32-10 a](a.md)\n- [31-13 b](b.md)\n- [00-00 c](c.md)\n- [31-10-2026 d](d.md)')).toBe(1);
  });
  it('R4 — le poids est celui des lignes datées, fin de ligne comprise', async () => {
    const line = '- [31-10 e](a.md)';
    expect(await closeWith(`# T\n${line}\n- [Profil](p.md)`)).toContain(`1 entrée(s) datée(s) (${Buffer.byteLength(line) + 1} octets)`);
  });
});

describe('session close — index mémoire', () => {
  it('R4 — la section cite taille, seuil, nombre et poids des entrées datées', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    const text = indexOf(13_000, 3);
    writeFileSync(m.index, text);
    const { out, code } = await cadIn(dir, m.env, 'session', 'close');
    const poids = [0, 1, 2].reduce((n, i) => n + Buffer.byteLength(`- **[31-10 : piege ${i}](p${i}.md)** - texte`) + 1, 0);
    expect(code).toBe(0);
    expect(out).toContain("Mémoire : l'index MEMORY.md pèse 13000 octets (seuil 12000)");
    expect(out).toContain(`3 entrée(s) datée(s) (${poids} octets) à regrouper sous une ligne vers un index secondaire — le skill propose, l'humain décide`);
  });
  it('R4 — sans entrée datée : « aucune entrée datée à regrouper »', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    writeFileSync(m.index, indexOf(13_000, 0));
    const { out } = await cadIn(dir, m.env, 'session', 'close');
    expect(out).toContain("Mémoire : l'index MEMORY.md pèse 13000 octets (seuil 12000)");
    expect(out).toContain("aucune entrée datée à regrouper dans l'index MEMORY.md");
    expect(out).not.toContain('à regrouper sous une ligne');
  });
  it('R2 — fichier de 0 octet : aucun avertissement', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    writeFileSync(m.index, '');
    expect((await cadIn(dir, m.env, 'session', 'close', '--config', join(dir, 'cadence.yaml'))).out).not.toContain('Mémoire');
  });
  it('R2 — 12000 octets pile : aucun avertissement', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    writeFileSync(m.index, indexOf(12_000));
    expect((await cadIn(dir, m.env, 'session', 'close')).out).not.toContain('Mémoire');
  });
  it('R2 — 12001 octets : avertissement', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    writeFileSync(m.index, indexOf(12_001));
    expect((await cadIn(dir, m.env, 'session', 'close')).out).toContain('pèse 12001 octets (seuil 12000)');
  });
  it('R2 — fichier absent : aucun avertissement', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    expect((await cadIn(dir, m.env, 'session', 'close')).out).not.toContain('Mémoire');
  });
  it('R1 — lancé dans un sous-dossier d’un dépôt git : le dossier du cwd est mesuré, pas la racine git', async () => {
    const dir = await project();
    const sub = join(dir, 'sous', 'dossier');
    mkdirSync(sub, { recursive: true });
    const racine = memoryFor(dir);
    writeFileSync(racine.index, indexOf(13_000));
    // la mémoire de la racine git n'est pas celle du dossier de lancement
    expect((await cadIn(sub, racine.env, 'session', 'close')).out).not.toContain('Mémoire');
    const mem = join(projectLogDir(racine.home, sub), 'memory');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'MEMORY.md'), indexOf(13_000));
    expect((await cadIn(sub, racine.env, 'session', 'close')).out).toContain('pèse 13000 octets');
  });
  it('R1 — session close --all : chaque section mesure la mémoire de son projet et pas celle du parent', async () => {
    const root = tempDir();
    const a = await project(undefined, gitRepo(root));
    const home = tempDir();
    const memA = join(projectLogDir(home, a), 'memory');
    mkdirSync(memA, { recursive: true });
    writeFileSync(join(memA, 'MEMORY.md'), indexOf(13_000));
    const parentMem = join(projectLogDir(home, root), 'memory');
    mkdirSync(parentMem, { recursive: true });
    writeFileSync(join(parentMem, 'MEMORY.md'), indexOf(14_000));
    const { out } = await cadIn(root, { CLAUDE_CONFIG_DIR: home }, 'session', 'close', '--all');
    expect(out).toContain('## depot');
    expect(out).toContain('pèse 13000 octets');
    expect(out).not.toContain('14000');
  });
  it('R1 — MEMORY.md lien symbolique : la taille de la cible est mesurée', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    const target = join(tempDir(), 'cible.md');
    writeFileSync(target, indexOf(13_000));
    symlinkSync(target, m.index);
    expect((await cadIn(dir, m.env, 'session', 'close')).out).toContain('pèse 13000 octets');
  });
  it('R5 — index trop gros et dépôt propre : code 0 et « ✓ prêt à fermer »', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    writeFileSync(m.index, indexOf(13_000));
    const { code, out } = await cadIn(dir, m.env, 'session', 'close');
    expect(code).toBe(0);
    expect(out).toMatch(/\n✓ prêt à fermer$/);
  });
  it('R5 — index trop gros et dépôt sale : le nombre de points ouverts est inchangé', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    writeFileSync(join(dir, '.cadence/raf.yaml'), `${readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')}\n# sale\n`);
    const sans = await cadIn(dir, m.env, 'session', 'close');
    writeFileSync(m.index, indexOf(13_000));
    const avec = await cadIn(dir, m.env, 'session', 'close');
    expect(sans.code).toBe(1);
    expect(avec.code).toBe(1);
    expect(sans.out).toMatch(/✗ pas fermé : \d+ point\(s\)$/);
    expect(avec.out.match(/✗ pas fermé : \d+ point\(s\)$/)![0]).toBe(sans.out.match(/✗ pas fermé : \d+ point\(s\)$/)![0]);
  });
  it('R6 — sortie de session close inchangée sous le seuil', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    const sans = await cadIn(dir, m.env, 'session', 'close');
    writeFileSync(m.index, indexOf(5_000));
    expect((await cadIn(dir, m.env, 'session', 'close')).out).toBe(sans.out);
  });
  it('R7 — sans clé : seuil 12000 (close)', async () => {
    const dir = await project('session:\n  cleanDays: 7\n');
    const m = memoryFor(dir);
    writeFileSync(m.index, indexOf(13_000));
    expect((await cadIn(dir, m.env, 'session', 'close')).out).toContain('(seuil 12000)');
  });
  it('R7 — memory.indexMaxBytes: 5000 : seuil 5000 en close, même verdict sur un index de 6000 octets', async () => {
    const dir = await project('memory:\n  indexMaxBytes: 5000\n');
    const m = memoryFor(dir);
    writeFileSync(m.index, indexOf(6_000));
    expect((await cadIn(dir, m.env, 'session', 'close')).out).toContain('pèse 6000 octets (seuil 5000)');
  });
  it.each(['0', '"abc"', '1.5', '-3', '"5000"'])('R7 — close avec memory.indexMaxBytes: %s : code 2 et message exact, aucun rapport', async (value) => {
    const dir = await project(`memory:\n  indexMaxBytes: ${value}\n`);
    const m = memoryFor(dir);
    writeFileSync(m.index, indexOf(13_000));
    const { code, out, err } = await cadIn(dir, m.env, 'session', 'close');
    const shown = value.replace(/"/g, '');
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toBe(`raf: ${join(dir, 'cadence.yaml')} : memory.indexMaxBytes doit être un entier ≥ 1 (octets), pas ${shown}`);
  });
  it('R8 — session close n’écrit aucun fichier sous le dossier de mémoire (empreinte avant/après identique)', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    writeFileSync(m.index, indexOf(13_000));
    const avant = [fingerprint(m.home), readFileSync(m.index, 'utf8')];
    await cadIn(dir, m.env, 'session', 'close');
    expect([fingerprint(m.home), readFileSync(m.index, 'utf8')]).toEqual(avant);
  });
  it('R8 — le skill session-close décrit la proposition et l’accord de l’humain', () => {
    const skill = readFileSync(join(SKILLS_DIR, 'session-close', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(skill).toContain('section "Mémoire"');
    expect(skill).toContain('secondary index');
    expect(skill).toContain('only after the human agrees');
    const lead = readFileSync(join(SKILLS_DIR, 'lead', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(lead).toContain('mémoire ·');
  });
  it('R9 — MEMORY.md est un dossier : une ligne d’illisibilité, code de sortie inchangé', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    mkdirSync(m.index);
    const { code, out } = await cadIn(dir, m.env, 'session', 'close');
    expect(out).toMatch(/Mémoire : l'index MEMORY\.md est illisible \(EISDIR[^)]*\), sa taille n'est pas contrôlée/);
    expect(code).toBe(0);
    expect(out).toMatch(/\n✓ prêt à fermer$/);
  });
  it.skipIf(process.getuid?.() === 0)('R9 — MEMORY.md sans droit de lecture : idem', async () => {
    const dir = await project();
    const m = memoryFor(dir);
    writeFileSync(m.index, indexOf(13_000));
    chmodSync(m.index, 0o000);
    const { code, out } = await cadIn(dir, m.env, 'session', 'close');
    expect(out).toMatch(/Mémoire : l'index MEMORY\.md est illisible \(EACCES[^)]*\)/);
    expect(code).toBe(0);
  });
});

/** Un dossier parent avec un projet « alpha » propre ; `yaml` : son cadence.yaml. */
async function parentWith(yaml?: string) {
  const root = tempDir();
  await project(undefined, gitRepo(root));
  if (yaml !== undefined) writeFileSync(join(root, 'cadence.yaml'), yaml);
  return root;
}

describe('lead tour — index mémoire', () => {
  it('R6 — sortie de lead tour inchangée sans index', async () => {
    const root = await parentWith();
    const m = memoryFor(root);
    const sans = await cadIn(root, m.env, 'lead', 'tour');
    expect(sans.out).not.toContain('mémoire ·');
    writeFileSync(m.index, indexOf(5_000));
    expect((await cadIn(root, m.env, 'lead', 'tour')).out).toBe(sans.out);
  });
  it('R1 — lead tour [dossier] mesure la mémoire du dossier résolu', async () => {
    const root = await parentWith();
    const m = memoryFor(root);
    writeFileSync(m.index, indexOf(13_000));
    const ailleurs = tempDir();
    expect((await cadIn(ailleurs, m.env, 'lead', 'tour', root)).out).toContain('mémoire · MEMORY.md 13000 octets > seuil 12000');
    expect((await cadIn(root, m.env, 'lead', 'tour', ailleurs)).out).not.toContain('mémoire ·');
  });
  it('R4 — la ligne du tour cite taille, seuil et nombre, après les lignes de projets et avant la porte de tests et les créneaux', async () => {
    const root = await parentWith();
    const m = memoryFor(root);
    writeFileSync(m.index, indexOf(13_000, 3));
    const lines = (await cadIn(root, m.env, 'lead', 'tour')).out.split('\n');
    const i = lines.findIndex((l) => l.startsWith('mémoire ·'));
    expect(lines[i]).toBe('mémoire · MEMORY.md 13000 octets > seuil 12000 · 3 entrée(s) datée(s) à regrouper (cadence session close détaille)');
    expect(lines[i - 1]).toMatch(/^depot · /);
    expect(lines[i + 1]).toMatch(/^depot · porte de tests absente/);
  });
  it('R4 — tour sans entrée datée : la ligne le dit', async () => {
    const root = await parentWith();
    const m = memoryFor(root);
    writeFileSync(m.index, indexOf(13_000, 0));
    expect((await cadIn(root, m.env, 'lead', 'tour')).out).toContain('mémoire · MEMORY.md 13000 octets > seuil 12000 · aucune entrée datée à regrouper');
  });
  it('R2 — tour : 12000 octets pile, aucune ligne ; 12001, une ligne', async () => {
    const root = await parentWith();
    const m = memoryFor(root);
    writeFileSync(m.index, indexOf(12_000));
    expect((await cadIn(root, m.env, 'lead', 'tour')).out).not.toContain('mémoire ·');
    writeFileSync(m.index, indexOf(12_001));
    expect((await cadIn(root, m.env, 'lead', 'tour')).out).toContain('MEMORY.md 12001 octets > seuil 12000');
  });
  it('R7 — memory.indexMaxBytes: 5000 : seuil 5000 en tour, même verdict qu’en close sur un index de 6000 octets', async () => {
    const yaml = 'memory:\n  indexMaxBytes: 5000\n';
    const root = await parentWith(yaml);
    const m = memoryFor(root);
    writeFileSync(m.index, indexOf(6_000));
    expect((await cadIn(root, m.env, 'lead', 'tour')).out).toContain('mémoire · MEMORY.md 6000 octets > seuil 5000');
    const dir = await project(yaml);
    const c = memoryFor(dir);
    writeFileSync(c.index, indexOf(6_000));
    expect((await cadIn(dir, c.env, 'session', 'close')).out).toContain('pèse 6000 octets (seuil 5000)');
  });
  it('R7 — tour avec memory.indexMaxBytes: 0 : code 0, ligne d’erreur, pas de ligne « mémoire »', async () => {
    const root = await parentWith('memory:\n  indexMaxBytes: 0\n');
    const m = memoryFor(root);
    writeFileSync(m.index, indexOf(13_000));
    const { code, out } = await cadIn(root, m.env, 'lead', 'tour');
    expect(code).toBe(0);
    expect(out).toContain('cadence.yaml · ✗ erreur : memory.indexMaxBytes doit être un entier ≥ 1 (octets), pas 0');
    expect(out).not.toContain('mémoire ·');
    expect(out).toMatch(/^depot · /m);
  });
  it('R9 — tour, MEMORY.md est un dossier : une ligne d’illisibilité, le tour continue', async () => {
    const root = await parentWith();
    const m = memoryFor(root);
    mkdirSync(m.index);
    const { code, out } = await cadIn(root, m.env, 'lead', 'tour');
    expect(code).toBe(0);
    expect(out).toMatch(/^mémoire · MEMORY\.md illisible \(EISDIR[^)]*\)$/m);
    expect(out).toMatch(/^vagues en cours/m);
  });
  it('R10 — lead tour --json avec index trop gros : JSON identique à celui sans index', async () => {
    const root = await parentWith();
    const m = memoryFor(root);
    const sans = await cadIn(root, m.env, 'lead', 'tour', '--json');
    writeFileSync(m.index, indexOf(13_000));
    const avec = await cadIn(root, m.env, 'lead', 'tour', '--json');
    expect(avec.out).toBe(sans.out);
    expect(JSON.parse(avec.out)).toBeInstanceOf(Array);
  });
  it('R8 — lead tour n’écrit rien sous le dossier de mémoire', async () => {
    const root = await parentWith();
    const m = memoryFor(root);
    writeFileSync(m.index, indexOf(13_000));
    const avant = fingerprint(m.home);
    await cadIn(root, m.env, 'lead', 'tour');
    expect(fingerprint(m.home)).toBe(avant);
  });
});
