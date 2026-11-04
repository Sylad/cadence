import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { verdictFor } from '../src/gate-verdict.js';
import { lockfileFingerprint, openRemoteGate, shq } from '../src/remote-gate.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { verifyGate } from '../src/verify-gate.js';
import { fakeRemote, type FakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

interface Proj {
  repo: string;
  sha: string;
  remote: FakeRemote;
  /** Où les commandes de la porte écrivent leur dossier courant et leurs lignes. */
  mark: string;
  /** Dossier de travail du projet sur l'hôte. */
  work: string;
}

/**
 * Projet dont cadence.yaml donne `orchestrate` (YAML déjà indenté) ; package-lock.json committé, node_modules (ignoré) présent sur le disque local.
 * `{MARK}` dans le YAML devient le fichier-témoin : ce que les commandes y écrivent dit où elles ont tourné.
 */
function project(orchestrate: string, o: { verify?: string; lock?: string | null; name?: string } = {}): Proj {
  const remote = fakeRemote();
  const mark = join(tempDir(), 'ran.log');
  const name = o.name ?? 'depot';
  const parent = tempDir();
  const repo = join(parent, name);
  mkdirSync(repo);
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(repo, ...a);
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n${orchestrate.replaceAll('{MARK}', mark)}verify:\n${o.verify ?? '  inPlace: false\n'}`);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  if (o.lock !== null) writeFileSync(join(repo, 'package-lock.json'), o.lock ?? '{"v":1}\n');
  writeFileSync(join(repo, 'valeur.txt'), 'v1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'local');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD'), remote, mark, work: join(remote.home, '.cadence-gate', name) };
}

/** Un commit de plus : le sha suivant, même lockfile. */
function nextSha(p: Proj, file = 'valeur.txt'): string {
  appendFileSync(join(p.repo, file), 'x\n');
  git(p.repo, 'commit', '-qam', 'next');
  return git(p.repo, 'rev-parse', 'HEAD');
}

async function gate(p: Proj, sha = p.sha, over: { env?: Record<string, string | undefined>; timeoutMs?: number; cores?: number } = {}) {
  const lines: string[] = [];
  const cfg = join(p.repo, 'cadence.yaml');
  const code = await verifyGate({ repo: p.repo, sha, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), env: { ...p.remote.env, ...over.env }, timeoutMs: over.timeoutMs, cores: over.cores, out: (l) => lines.push(l) });
  return { code, text: lines.join('\n'), lines };
}

const marks = (p: Proj): string[] => (existsSync(p.mark) ? readFileSync(p.mark, 'utf8').split('\n').filter(Boolean) : []);
const caches = (p: Proj): string[] => (existsSync(join(p.work, 'deps')) ? readdirSync(join(p.work, 'deps')) : []);
const trees = (p: Proj): string[] => (existsSync(join(p.work, 'wt')) ? readdirSync(join(p.work, 'wt')) : []);
const INSTALL = (mark: string) => `  gate:\n    host: machine\n    install: mkdir -p node_modules/p && echo hi > node_modules/p/i.js && echo "install $(pwd)" >> ${mark}\n`;
const withInstall = (extra = '') => `  test: echo "tests $(pwd)" >> {MARK}\n${INSTALL('{MARK}')}${extra}`;
const withHost = '  test: echo "tests $(pwd)" >> {MARK}\n  gate:\n    host: machine\n';

describe('L403 — porte déportée : sans hôte, rien ne change (R1)', () => {
  it('R1 — gate.host absent : aucune commande ssh lancée et la première ligne de sortie est celle d\'avant', async () => {
    const p = project('  test: echo "tests $(pwd)" >> {MARK}\n');
    const r = await gate(p);
    expect(r.code).toBe(0);
    expect(p.remote.commands()).toEqual([]);
    expect(r.lines[0]).toMatch(/^verify --gate \w{7} : porte jouée dans une copie jetable /);
    expect(existsSync(p.work)).toBe(false);
  });
});

describe('L403 — la porte jouée sur l\'hôte (C1)', () => {
  it('R10 — première ligne : hôte, sha et état du cache', async () => {
    const p = project(withInstall());
    const r = await gate(p);
    const fp = lockfileFingerprint(p.repo, p.sha)!.fp.slice(0, 8);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(`verify --gate ${p.sha.slice(0, 7)} : porte jouée sur l'hôte machine (sha ${p.sha.slice(0, 7)}, cache rempli par gate.install (empreinte ${fp}))`);
    expect(marks(p).filter((l) => l.startsWith('tests'))[0]).toContain(`${p.work}/wt/`);
  });

  it('R3 — même lockfile à deux shas : le second appel n\'installe pas', async () => {
    const p = project(withInstall());
    await gate(p);
    const second = await gate(p, nextSha(p));
    expect(marks(p).filter((l) => l.startsWith('install'))).toHaveLength(1);
    expect(second.lines[0]).toContain('cache utilisé');
    expect(caches(p)).toHaveLength(1);
  });

  it('R3 — lockfile modifié : nouveau cache rempli', async () => {
    const p = project(withInstall());
    await gate(p);
    writeFileSync(join(p.repo, 'package-lock.json'), '{"v":2}\n');
    git(p.repo, 'commit', '-qam', 'lock');
    const r = await gate(p, git(p.repo, 'rev-parse', 'HEAD'));
    expect(r.lines[0]).toContain('cache rempli');
    expect(marks(p).filter((l) => l.startsWith('install'))).toHaveLength(2);
    expect(caches(p)).toHaveLength(2);
  });

  it('R3 — le worktree distant a une copie des dépendances, pas un lien', async () => {
    const p = project(`  test: test -f node_modules/p/i.js && ! test -L node_modules && ! test -L node_modules/p/i.js && echo changed >> node_modules/p/i.js\n${INSTALL('{MARK}')}`);
    const r = await gate(p);
    expect(r.code).toBe(0);
    // Le test a modifié le fichier dans le worktree : le cache, lui, est intact.
    const cached = readFileSync(join(p.work, 'deps', caches(p)[0], 'node_modules', 'p', 'i.js'), 'utf8');
    expect(cached).toBe('hi\n');
  });

  it('R8 — vert distant : verdict noté pour le sha dans l\'état local', async () => {
    const p = project(withInstall());
    expect(verdictFor(p.repo, p.sha)).toBeNull();
    expect((await gate(p)).code).toBe(0);
    expect(verdictFor(p.repo, p.sha)?.code).toBe(0);
  });

  it('R8 — rouge distant : même sortie ✗ et mêmes tests nommés qu\'en local', async () => {
    const red = (host: string) => `  test: echo ' FAIL  a.test.ts > suite > cas un'; echo ' FAIL  b.test.ts > suite > cas deux'; exit 1\n${host}`;
    const remote = project(red('  gate:\n    host: machine\n    install: mkdir -p node_modules\n'));
    const local = project(red(''));
    const r = await gate(remote);
    const l = await gate(local);
    const pick = (t: string) => t.split('\n').filter((x) => x.startsWith('✗') || x.startsWith('  - '));
    expect(r.code).toBe(1);
    expect(pick(r.text)).toEqual(pick(l.text));
    expect(pick(r.text)).toEqual(expect.arrayContaining(['  - a.test.ts > suite > cas un', '  - b.test.ts > suite > cas deux']));
    expect(verdictFor(remote.repo, remote.sha)?.code).toBe(1);
  });

  it('R8 — rejeu seul des rouges joué sur l\'hôte', async () => {
    const p = project(`  test: pwd >> {MARK}; echo ' FAIL  a.test.ts > suite > cas'; exit 1\n  testReplay: pwd >> {MARK}; echo ran {files}\n  gate:\n    host: machine\n    install: mkdir -p node_modules\n`);
    const r = await gate(p);
    expect(r.text).toContain('instables sous charge');
    expect(r.code).toBe(0);
    const where = marks(p);
    expect(where).toHaveLength(2);
    for (const w of where) expect(w).toContain(`${p.work}/wt/`);
  });

  it('R10 — rouge : le worktree distant est retiré', async () => {
    const p = project('  test: exit 1\n  gate:\n    host: machine\n    install: mkdir -p node_modules\n');
    const r = await gate(p);
    expect(r.code).toBe(1);
    expect(trees(p)).toEqual([]);
    expect(git(join(p.work, 'repo.git'), 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('R10 — délai : le worktree distant est retiré', async () => {
    const p = project('  test: sleep 31337.1\n  gate:\n    host: machine\n    install: mkdir -p node_modules\n');
    const r = await gate(p, p.sha, { timeoutMs: 1500 });
    expect(r.code).toBe(1);
    expect(r.text).toContain('délai dépassé');
    expect(trees(p)).toEqual([]);
  });

  it('R19 — délai : la commande distante est arrêtée côté hôte (plus de processus du groupe)', async () => {
    // L555 : durée propre à ce processus de test — pgrep -f voit les processus de toute la machine, dont ceux d'un autre test en parallèle
    const marker = `sleep 31337.${process.pid}`;
    const p = project(`  test: ${marker}\n  gate:\n    host: machine\n    install: mkdir -p node_modules\n`);
    await gate(p, p.sha, { timeoutMs: 1500 });
    // L555 : l'arrêt du groupe n'est pas instantané sous charge : on laisse jusqu'à 10 s au dernier processus pour disparaître
    const pattern = `sleep 31337\\.${process.pid}$`; // ancré : un pid qui commence pareil n'est pas le nôtre
    for (let t = 0; t < 10_000 && spawnPgrep(pattern); t += 100) await new Promise((r) => setTimeout(r, 100));
    expect(spawnPgrep(pattern)).toBe(false);
  });

  it('R19 — délai puis autre commande : le groupe de la commande en délai est aussi arrêté côté hôte (un pid par commande)', async () => {
    const marker = `sleep 31338.${process.pid}`;
    const p = project('  test: true\n  gate:\n    host: machine\n    install: mkdir -p node_modules\n');
    const o = await openRemoteGate({ host: 'machine', install: 'mkdir -p node_modules', repo: p.repo, sha: p.sha, depsFrom: p.repo, env: p.remote.env, timeoutMs: 30_000, workers: () => 1 });
    if (!o.ok) throw new Error(o.cause);
    const pattern = `sleep 31338\\.${process.pid}$`;
    await o.gate.run(marker, 1500);
    await o.gate.run('true', 30_000);
    expect(o.gate.close()).toBeNull();
    for (let t = 0; t < 10_000 && spawnPgrep(pattern); t += 100) await new Promise((r) => setTimeout(r, 100));
    expect(spawnPgrep(pattern)).toBe(false);
    expect(trees(p)).toEqual([]);
  });

  it('R19 — nettoyage en échec : dit dans la sortie, worktree orphelin retiré au prochain appel', async () => {
    const p = project(withInstall());
    p.remote.lose('for i in');
    const r = await gate(p);
    expect(r.text).toMatch(/nettoyage de l'hôte machine en échec \(.*\) — le worktree orphelin y sera retiré au prochain appel/);
    expect(trees(p).filter((t) => !t.endsWith('.pid'))).toHaveLength(1);
    p.remote.lose();
    // Le temps passe : l'orphelin a plus de 6 h.
    const old = new Date(Date.now() - 7 * 3600_000);
    for (const t of trees(p)) utimesSync(join(p.work, 'wt', t), old, old);
    await gate(p, nextSha(p));
    expect(trees(p)).toEqual([]);
  });
});

function spawnPgrep(pattern: string): boolean {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('L403 — repli sur la porte locale (R4, R5)', () => {
  it('R4 — hôte injoignable : la porte tourne en local et la sortie nomme l\'hôte et la cause', async () => {
    const p = project(withHost);
    p.remote.down();
    const r = await gate(p);
    expect(r.code).toBe(0);
    expect(r.text).toContain('verify --gate : porte déportée indisponible sur machine (ssh: connect to host machine port 22: Connection refused) — repli sur la porte locale');
    expect(marks(p)).toHaveLength(1);
    expect(marks(p)[0]).not.toContain('.cadence-gate');
    expect(verdictFor(p.repo, p.sha)?.code).toBe(0);
  });

  it('R4 — la sonde n\'attend jamais un mot de passe (BatchMode)', async () => {
    const p = project(withHost);
    p.remote.down();
    await gate(p);
    expect(p.remote.commands()).toHaveLength(1);
    expect(p.remote.options()).toEqual(expect.arrayContaining(['BatchMode=yes']));
    expect(p.remote.options().some((o) => o.startsWith('ConnectTimeout='))).toBe(true);
  });

  it('R5 — push refusé : repli local dit, code de la porte locale', async () => {
    const p = project(withInstall());
    p.remote.lose('git-receive-pack');
    const r = await gate(p);
    expect(r.text).toMatch(/porte déportée indisponible sur machine \(push du sha impossible : .*\) — repli sur la porte locale/);
    expect(r.code).toBe(0);
    expect(marks(p).filter((l) => l.startsWith('tests'))[0]).not.toContain('.cadence-gate');
  });

  it('R17 — installation en échec : aucun dossier deps/<empreinte> publié', async () => {
    const p = project('  test: echo ok\n  gate:\n    host: machine\n    install: mkdir -p node_modules/p && exit 3\n');
    const r = await gate(p);
    expect(r.text).toMatch(/cache de dépendances impossible sur machine \(gate\.install en échec sur machine \(code 3\).*\) — repli sur la porte locale/);
    expect(caches(p)).toEqual([]);
    expect(trees(p)).toEqual([]);
  });

  it('R5 — sha absent du dépôt local : repli local dit, la porte ne plante pas', async () => {
    const p = project(withInstall());
    const r = await gate(p, 'deadbeef');
    expect(r.text).toMatch(/porte déportée indisponible sur machine \(.*\) — repli sur la porte locale/);
  });

  it('R5 — installation du cache en échec : repli local, aucun cache à moitié rempli réutilisé', async () => {
    const p = project(`  test: echo "tests $(pwd)" >> {MARK}\n  gate:\n    host: machine\n    install: mkdir -p node_modules/p && echo half > node_modules/p/i.js && echo "$(pwd)" >> ${'{MARK}'}.tries && test ! -f ${'{MARK}'}.fail\n`);
    writeFileSync(`${p.mark}.fail`, '');
    const first = await gate(p);
    expect(first.text).toContain('cache de dépendances impossible');
    expect(caches(p)).toEqual([]);
    rmSync(`${p.mark}.fail`);
    const second = await gate(p, nextSha(p));
    expect(second.lines[0]).toContain('cache rempli par gate.install');
    expect(readFileSync(`${p.mark}.tries`, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('L403 — connexion perdue pendant une commande (R6, C1)', () => {
  it('R6 — verify --gate, code 255 : la porte est rejouée en local et la sortie le dit', async () => {
    const p = project(withInstall());
    p.remote.lose('export CADENCE_TEST_WORKERS');
    const r = await gate(p);
    expect(r.text).toContain('verify --gate : connexion perdue avec machine pendant la porte — rejouée en local');
    expect(r.code).toBe(0);
    expect(r.text).not.toContain('rouge');
    expect(marks(p).filter((l) => l.startsWith('tests'))[0]).not.toContain('.cadence-gate');
    expect(verdictFor(p.repo, p.sha)?.code).toBe(0);
  });

  it('R6 — code 1 d\'un test (vague comme verify --gate) : verdict rouge, pas de repli (R8)', async () => {
    const p = project(`  test: echo "tests $(pwd)" >> {MARK}; exit 1\n  gate:\n    host: machine\n    install: mkdir -p node_modules\n`);
    const r = await gate(p);
    expect(r.code).toBe(1);
    expect(r.text).not.toContain('rejouée en local');
    expect(marks(p)).toHaveLength(1);
  });
});

describe('L403 — inPlace et plusieurs hôtes de la précédence (R9)', () => {
  it('R9 — inPlace true et host : porte dans l\'arbre principal, hôte ignoré, dit', async () => {
    const p = project(withInstall(), { verify: '  inPlace: true\n' });
    const r = await gate(p);
    expect(r.text).toContain('verify --gate : verify.inPlace demande l\'arbre principal, l\'hôte machine est ignoré');
    expect(r.lines.find((l) => l.includes('porte jouée'))).toContain('arbre principal');
    expect(p.remote.commands()).toEqual([]);
  });

  it('R9 — inPlace absent et host : porte sur l\'hôte', async () => {
    const p = project(withInstall(), { verify: '  copies: true\n' });
    writeFileSync(join(p.repo, 'cadence.yaml'), readFileSync(join(p.repo, 'cadence.yaml'), 'utf8').replace('verify:\n  copies: true\n', ''));
    git(p.repo, 'commit', '-qam', 'sans verify');
    const sha = git(p.repo, 'rev-parse', 'HEAD');
    const r = await gate(p, sha);
    expect(r.lines[0]).toContain('porte jouée sur l\'hôte machine');
  });
});

describe('L403 — CADENCE_TEST_WORKERS de l\'hôte (R13)', () => {
  const workers = (p: Proj) => marks(p)[0];
  const cmd = '  test: echo $CADENCE_TEST_WORKERS >> {MARK}\n  gate:\n    host: machine\n    install: mkdir -p node_modules\n';

  it('R13 — nproc de l\'hôte 16, plafond 2 : 8 workers', async () => {
    const p = project(cmd);
    p.remote.machine({ nproc: 16 });
    await gate(p, p.sha, { env: { CADENCE_MAX_SESSIONS: '2', CADENCE_TEST_WORKERS: undefined }, cores: 4 });
    expect(workers(p)).toBe('8');
  });

  it('R13 — valeur entière de l\'environnement conservée', async () => {
    const p = project(cmd);
    p.remote.machine({ nproc: 16 });
    await gate(p, p.sha, { env: { CADENCE_MAX_SESSIONS: '2', CADENCE_TEST_WORKERS: '3' } });
    expect(workers(p)).toBe('3');
  });
});

describe('L403 — cache par copie des dépendances locales (R15, R16)', () => {
  const copyProject = () => project('  test: test -f node_modules/dep/index.js && echo "tests $(pwd)" >> {MARK}\n  gate:\n    host: machine\n');

  it('R16 — empreinte et plateforme égales : copie faite et cache utilisé au second appel', async () => {
    const p = copyProject();
    const first = await gate(p);
    expect(first.code).toBe(0);
    expect(first.lines[0]).toContain('cache rempli par copie des dépendances locales');
    const second = await gate(p, nextSha(p));
    expect(second.lines[0]).toContain('cache utilisé');
    expect(caches(p)).toHaveLength(1);
    expect(second.code).toBe(0);
  });

  it('R16 — lockfile local différent de celui du sha : aucune copie, repli local dit', async () => {
    const p = copyProject();
    writeFileSync(join(p.repo, 'package-lock.json'), '{"v":99}\n'); // le disque local n'est plus au lockfile du sha
    const r = await gate(p);
    expect(r.text).toContain('cache de dépendances impossible sur machine (gate.install absent et lockfile local différent de celui du sha');
    expect(caches(p)).toEqual([]);
    expect(r.code).toBe(0);
  });

  it('R16 — plateforme locale différente de l\'hôte : aucune copie, repli local dit', async () => {
    const p = copyProject();
    p.remote.machine({ os: 'Plan9', arch: 'mips' });
    const r = await gate(p);
    expect(r.text).toMatch(/cache de dépendances impossible sur machine \(gate\.install absent et plateforme locale \S+ différente de celle de l'hôte plan9-mips/);
    expect(caches(p)).toEqual([]);
  });

  it('R15 — gate.install déclaré : joué sur l\'hôte, dans un worktree au sha, une fois par empreinte', async () => {
    const p = project(withInstall());
    await gate(p);
    await gate(p, nextSha(p));
    const installs = marks(p).filter((l) => l.startsWith('install'));
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatch(new RegExp(`install ${p.work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/wt/[\\w-]+-i$`));
  });

  it('R15 — sans gate.install et copie locale refusée par R16 : repli local dit', async () => {
    const p = copyProject();
    rmSync(join(p.repo, 'node_modules'), { recursive: true });
    const r = await gate(p);
    expect(r.text).toContain('cache de dépendances impossible sur machine (gate.install absent et aucune dépendance locale à copier) — repli sur la porte locale');
  });
});

describe('L403 — cache sûr en concurrence (R17)', () => {
  it('R17 — deux remplissages simultanés de même empreinte : un seul cache publié, les deux portes lisent un cache complet', async () => {
    // L579 : `sleep 1` pour que les deux remplissages se chevauchent était un délai de travail, pas une attente : sous charge une porte pouvait
    // finir avant que l'autre commence, et le cas disputé n'était pas joué. Chaque installation signale son arrivée et attend celle de l'autre :
    // les deux publient ensuite, quelle que soit la charge (bornée à 20 s : un échec visible, pas une boucle perdue).
    const arrivees = join(tempDir(), 'arrivees');
    const p = project(`  test: test -f node_modules/p/i.js\n  gate:\n    host: machine\n    install: mkdir -p ${arrivees} && touch ${arrivees}/$$ && n=0 && while [ $(ls ${arrivees} | wc -l) -lt 2 ]; do n=$((n+1)); [ $n -lt 400 ] || exit 9; sleep 0.05; done; mkdir -p node_modules/p && echo hi > node_modules/p/i.js\n`);
    const [a, b] = await Promise.all([gate(p), gate(p)]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(readdirSync(arrivees)).toHaveLength(2); // les deux ont rempli : le cas disputé a bien eu lieu
    expect(caches(p)).toHaveLength(1);
    expect(readdirSync(join(p.work, 'deps', caches(p)[0])).sort()).toEqual(['.paths', 'node_modules']);
  });

  it('R17 — six portes simultanées sur un hôte neuf : le dépôt de travail est créé une fois, aucune ne se replie à cause de la création', async () => {
    const p = project(withInstall());
    const runs = await Promise.all(Array.from({ length: 6 }, () => gate(p)));
    expect(runs.map((r) => r.text).filter((t) => t.includes('dépôt de travail impossible'))).toEqual([]);
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(readdirSync(join(p.work)).filter((n) => n.startsWith('repo.git'))).toEqual(['repo.git']);
  });

  it('R17 — temporaire orphelin d\'un appel précédent nettoyé', async () => {
    const p = project(withInstall());
    await gate(p);
    const old = join(p.work, 'deps', '.tmp-vieux');
    const young = join(p.work, 'deps', '.tmp-recent');
    mkdirSync(old);
    mkdirSync(young);
    const past = new Date(Date.now() - 8 * 3600_000);
    utimesSync(old, past, past);
    await gate(p, nextSha(p));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });
});

describe('L403 — empreinte et quoting (R18)', () => {
  it('R18 — lockfile yarn.lock seul : empreinte calculée', async () => {
    const p = project(withInstall(), { lock: null });
    writeFileSync(join(p.repo, 'yarn.lock'), '# yarn\n');
    git(p.repo, 'add', 'yarn.lock');
    git(p.repo, 'commit', '-qm', 'yarn');
    const sha = git(p.repo, 'rev-parse', 'HEAD');
    const prints = lockfileFingerprint(p.repo, sha)!;
    expect(prints.files).toEqual(['yarn.lock']);
    expect(prints.fp).toMatch(/^[0-9a-f]{64}$/);
    const r = await gate(p, sha);
    expect(r.lines[0]).toContain(`empreinte ${prints.fp.slice(0, 8)}`);
    expect(caches(p)[0]).toMatch(new RegExp(`^${prints.fp}`));
  });

  it('R18 — lockfile d\'un sous-dossier compté, celui d\'un node_modules ignoré', () => {
    const p = project(withInstall());
    const before = lockfileFingerprint(p.repo, p.sha)!;
    mkdirSync(join(p.repo, 'front'));
    writeFileSync(join(p.repo, 'front', 'package-lock.json'), '{"front":1}\n');
    mkdirSync(join(p.repo, 'vendor', 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(p.repo, 'vendor', 'node_modules', 'x', 'package-lock.json'), '{}\n');
    git(p.repo, 'add', '-f', '.');
    git(p.repo, 'commit', '-qm', 'front');
    const after = lockfileFingerprint(p.repo, git(p.repo, 'rev-parse', 'HEAD'))!;
    expect(after.files).toEqual(['front/package-lock.json', 'package-lock.json']);
    expect(after.fp).not.toBe(before.fp);
  });

  it('R18 — sha abrégé hexadécimal accepté', async () => {
    const p = project(withInstall());
    const r = await gate(p, p.sha.slice(0, 7));
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain('porte jouée sur l\'hôte machine');
  });

  it('R18 — aucun lockfile : pas de cache, la porte joue', async () => {
    const p = project(withInstall(), { lock: null });
    writeFileSync(join(p.repo, 'valeur.txt'), 'v2\n');
    git(p.repo, 'commit', '-qam', 'v2');
    const sha = git(p.repo, 'rev-parse', 'HEAD');
    expect(lockfileFingerprint(p.repo, sha)).toBeNull();
    const r = await gate(p, sha);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain('sans cache (aucun lockfile au sha)');
    expect(caches(p)).toEqual([]);
    expect(marks(p).filter((l) => l.startsWith('install'))).toEqual([]);
  });

  it('R18 — sha « abc; rm -rf x » refusé avant toute commande ssh', async () => {
    const p = project(withInstall());
    const r = await gate(p, 'abc; rm -rf x');
    expect(r.code).toBe(2);
    expect(r.text).toContain('verify --gate : sha invalide pour la porte déportée (hexadécimal attendu)');
    expect(p.remote.commands()).toEqual([]);
  });

  it('R18 — chemin avec apostrophe correctement quoté', async () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`);
    const p = project(withInstall(), { name: "o'brien; touch pwned" });
    const r = await gate(p);
    expect(r.code).toBe(0);
    expect(existsSync(join(p.remote.home, 'pwned'))).toBe(false);
    expect(existsSync(join(p.remote.home, '.cadence-gate', "o'brien; touch pwned", 'repo.git'))).toBe(true);
  });
});

describe('L403 — pas de nom de machine ni de dépôt dans le code (R12, R14)', () => {
  it('R12 — aucun nom de machine ni de dépôt ne figure dans src/', () => {
    for (const f of ['remote-gate.ts', 'verify-gate.ts']) {
      const text = readFileSync(join(__dirname, '..', 'src', f), 'utf8');
      expect(text, f).not.toMatch(/dark-blue|big-blue|mini-blue|sladoire|developpeur|aetherwx|maritime|synology/i);
    }
  });

  it('R14 — le dossier distant est .cadence-gate/<nom du projet> et aucune autre clé n\'est lue', async () => {
    const p = project(withInstall(), { name: 'mon-projet' });
    await gate(p);
    expect(readdirSync(join(p.remote.home, '.cadence-gate'))).toEqual(['mon-projet']);
    expect(readdirSync(join(p.remote.home, '.cadence-gate', 'mon-projet')).sort()).toEqual(['deps', 'repo.git', 'wt']);
  });
});

describe('L403 — gate.host seul n\'est pas gate.readsPlan (R11)', () => {
  const PLAN = '.cadence/raf.yaml';

  /** Une vague qui a joué la porte au sha `head` de `repo`, puis un commit de plan seul au-dessus. */
  function waved(p: Proj): { launch: string; top: string } {
    const launch = tempDir();
    const store = RunStore.reserve(launch, '2026-10-30-0830')!;
    store.writeWave({ created: '2026-10-30T08:30:00.000Z', lots: ['p:L9'] } as never);
    const l = newLot({ project: 'p', repo: p.repo, lot: 'L9', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false });
    const checks: LotState['checks'] = { head: p.sha, tree: git(p.repo, 'rev-parse', `${p.sha}^{tree}`), runs: [{ label: 'tests', command: 'echo "tests $(pwd)" >> ' + p.mark, code: 0 }] };
    store.writeLot({ ...l, status: 'ready', checks });
    mkdirSync(join(p.repo, '.cadence'), { recursive: true });
    appendFileSync(join(p.repo, PLAN), 'raf done\n');
    git(p.repo, 'add', PLAN);
    git(p.repo, 'commit', '-qm', 'raf done');
    return { launch, top: git(p.repo, 'rev-parse', 'HEAD') };
  }

  async function gateWithPlan(p: Proj, launch: string, top: string) {
    const lines: string[] = [];
    const cfg = join(p.repo, 'cadence.yaml');
    await verifyGate({ repo: p.repo, sha: top, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), launchDirs: [launch], planFile: PLAN, env: p.remote.env, out: (l) => lines.push(l) });
    return lines.join('\n');
  }

  const yamlOf = (gate: string) => `  test: echo "tests $(pwd)" >> {MARK}\n  gate:\n${gate}`;

  it('R11 — gate: {host} seul : les commits de plan seuls reprennent encore le verdict', async () => {
    const p = project(yamlOf('    host: machine\n'));
    const { launch, top } = waved(p);
    const text = await gateWithPlan(p, launch, top);
    expect(text).toContain('verdict repris');
    expect(p.remote.commands()).toEqual([]);
  });

  it('R11 — gate: {host} seul : la sortie ne contient pas le message readsPlan', async () => {
    const p = project(yamlOf('    host: machine\n'));
    p.remote.down();
    const { top } = waved(p);
    const text = await gateWithPlan(p, tempDir(), top); // aucune vague : le verdict est rejoué
    expect(text).toContain('verdict rejoué');
    expect(text).not.toContain('orchestrate.gate.readsPlan');
  });

  it('R11 — gate: {host, readsPlan: true} : la reprise est coupée et le message est présent', async () => {
    const p = project(yamlOf('    host: machine\n    readsPlan: true\n'));
    p.remote.down();
    const { launch, top } = waved(p);
    const text = await gateWithPlan(p, launch, top);
    expect(text).not.toContain('verdict repris');
    expect(text).toContain('orchestrate.gate.readsPlan');
  });

  it('R11 — gate: {readsPlan: false} : config.gate non posé, comportement d\'avant', async () => {
    const p = project(yamlOf('    readsPlan: false\n'));
    expect(readOrchestrateConfig(join(p.repo, 'cadence.yaml')).gate).toBeUndefined();
    const { launch, top } = waved(p);
    expect(await gateWithPlan(p, launch, top)).toContain('verdict repris');
  });
});
