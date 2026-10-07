import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SKILLS_DIR } from '../src/skills.js';
import { run } from '../src/cli.js';
import { readNext, sharedStateDir, stateDir, writeLock } from '../src/state.js';
import { CLEAN_TODAY, cleanAt, commit, gitRepo, tempDir } from './helpers.js';

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-09-28' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-09-28T18:30:00'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Plan commité : L1 en cours (silencieux), L2 à faire, L3 gain rapide, L4 bloqué par L2. */
async function project() {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  await cad(dir, 'add', 'Cache', '--estimate', '2');
  await cad(dir, 'add', 'Export');
  await cad(dir, 'add', 'Typo', '--quickwin');
  await cad(dir, 'add', 'Après export', '--after', 'L2');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-09-20T09:00:00');
  await cad(dir, 'start', 'L1');
  const plan = join(dir, 'docs/plan/raf.yaml');
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('started: 2026-09-28', 'started: 2026-09-22'));
  git(dir, 'commit', '-qam', 'chore: plan');
  commit(dir, 'feat(L1): cache', '2026-09-24T10:00:00');
  return dir;
}

describe('session start', () => {
  it('rapporte les faits et propose trois lots du plan', async () => {
    const dir = await project();
    commit(dir, 'feat(L2): début export', '2026-09-28T09:00:00');
    commit(dir, 'wip sans lot', '2026-09-28T09:30:00');
    writeNext(dir, ['finir L1']);
    const { code, out } = await cad(dir, 'session', 'start', '--since', '2026-09-27');
    expect(code).toBe(0);
    expect(out).toContain('Notes de la dernière clôture (2026-09-27)\n  - finir L1');
    expect(out).toMatch(/En cours\n {2}L1 {2}Cache {2}\(dernière activité 2026-09-24, silencieux depuis 4 j\)/);
    expect(out).toMatch(/Fait depuis 2026-09-27\n {2}L2 — 1 commit\(s\) : feat\(L2\): début export\n {2}1 commit\(s\) sans lot/);
    expect(out).toContain('✗ L2 a 1 commit(s) mais est encore todo');
    expect(out).toContain('branche main, pas de branche amont');
    expect(out).toMatch(/Propositions\n {2}1\. L1 {2}Cache — en cours\n {2}2\. ⚡ L3 {2}Typo — gain rapide prêt\n {2}3\. L2 {2}Export — prêt/);
  });

  it('signale une livraison en cours et un verrou périmé', async () => {
    const dir = await project();
    writeLock(sharedStateDir(dir), { pid: process.pid, sha: 'abcdef1234', started: '2026-09-28T18:00:00.000Z' });
    expect((await cad(dir, 'session', 'start')).out).toContain(`Livraison en cours : abcdef1 (pid ${process.pid}, depuis 2026-09-28T18:00:00.000Z)`);
    const other = await project();
    writeLock(sharedStateDir(other), { pid: 2 ** 22 + 12345, sha: 'abcdef1234', started: 'x' });
    expect((await cad(other, 'session', 'start')).out).toContain('Verrou de livraison périmé');
  });

  it('refuse sans plan', async () => {
    expect((await cad(gitRepo(), 'session', 'start')).code).toBe(2);
  });
});

describe('session start : adoption du plan', () => {
  it('ne compte pas comme « sans lot » un commit antérieur à l’adoption', async () => {
    const dir = await project();
    commit(dir, 'vieux commit sans lot', '2026-09-26T09:00:00');
    const { out } = await cad(dir, 'session', 'start', '--since', '2026-09-25');
    expect(out).not.toContain('sans lot');
  });
});

describe('session close', () => {
  it('liste les commits sans lot et les lots en cours sans commit du jour, code 1', async () => {
    const dir = await project();
    commit(dir, 'wip sans lot', '2026-09-28T11:00:00');
    writeFileSync(join(dir, 'x.txt'), 'x');
    git(dir, 'add', 'x.txt');
    const { code, out } = await cad(dir, 'session', 'close');
    expect(code).toBe(1);
    expect(out).toMatch(/Commits de la période\n {2}1 commit\(s\) sans lot :\n {4}[0-9a-f]{7} wip sans lot/);
    expect(out).toContain('L1  Cache — aucun commit sur la période : raf done ou raf note');
    expect(out).toContain('1 fichier(s) modifié(s)');
    expect(out).toMatch(/✗ pas fermé : \d+ point\(s\)/);
  });

  it('code 0 sur un dépôt propre et poussé', async () => {
    const origin = tempDir();
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    const dir = await project();
    await cad(dir, 'done', 'L1');
    git(dir, 'commit', '-qam', 'chore: plan');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const { code, out } = await cad(dir, 'session', 'close', '--since', '2026-09-01');
    expect(out).toContain('✓ prêt à fermer');
    expect(code).toBe(0);
  });
});

describe('session next', () => {
  it('écrit les notes ; --clear les efface exprès', async () => {
    const dir = await project();
    expect((await cad(dir, 'session', 'next', 'finir L1', 'relire L2')).code).toBe(0);
    expect(readNext(stateDir(dir))).toEqual({ date: '2026-09-28', lines: ['finir L1', 'relire L2'] });
    const cleared = await cad(dir, 'session', 'next', '--clear');
    expect(cleared.code).toBe(0);
    expect(cleared.out).toContain('notes effacées (2 ligne(s) du 2026-09-28)');
    expect(readNext(stateDir(dir))).toBeNull();
    const again = await cad(dir, 'session', 'next', '--clear');
    expect(again.code).toBe(0);
    expect(again.out).toContain('aucune note à effacer');
  });

  it('sans ligne : refus (code 2), les notes de la dernière clôture restent, et la façon de les effacer est dite', async () => {
    const dir = await project();
    writeNext(dir, ['finir L1', 'relire L2']);
    for (const args of [[], [''], ['  ', '\n']]) {
      const r = await cad(dir, 'session', 'next', ...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain('aucune ligne');
      expect(r.err).toContain('2 ligne(s) du 2026-09-27 conservée(s)');
      expect(r.err).toContain('cadence session next --clear');
      expect(readNext(stateDir(dir))).toEqual({ date: '2026-09-27', lines: ['finir L1', 'relire L2'] });
    }
  });

  it('sans ligne et sans notes : refus aussi, rien n’est écrit', async () => {
    const dir = await project();
    const r = await cad(dir, 'session', 'next');
    expect(r.code).toBe(2);
    expect(r.err).toContain('aucune ligne');
    expect(r.err).toContain('cadence session next --clear');
    expect(readNext(stateDir(dir))).toBeNull();
  });

  it('--clear avec des lignes : refus, rien ne change', async () => {
    const dir = await project();
    writeNext(dir, ['finir L1']);
    const r = await cad(dir, 'session', 'next', '--clear', 'autre chose');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--clear');
    expect(readNext(stateDir(dir))).toEqual({ date: '2026-09-27', lines: ['finir L1'] });
  });

  it('une ligne blanche parmi les autres n’est pas écrite', async () => {
    const dir = await project();
    expect((await cad(dir, 'session', 'next', 'finir L1', ' ', 'relire L2')).code).toBe(0);
    expect(readNext(stateDir(dir))).toEqual({ date: '2026-09-28', lines: ['finir L1', 'relire L2'] });
  });
});

function writeNext(dir: string, lines: string[]) {
  writeFileSync(join(stateDir(dir), 'next.md'), `# 2026-09-27\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
}

describe('faits propres au projet (L2)', () => {
  it('session start et close jouent la commande de cadence.yaml, avec CADENCE_SINCE', async () => {
    const dir = await project();
    writeFileSync(
      join(dir, 'cadence.yaml'),
      'session:\n  start: echo "équipe du lot — depuis $CADENCE_SINCE"\n  close: echo "fiche du jour absente"; exit 3\n',
    );
    const start = await cad(dir, 'session', 'start', '--since', '2026-09-27');
    expect(start.code).toBe(0);
    expect(start.out).toMatch(/Faits propres au projet\n  équipe du lot — depuis 2026-09-27\n[\s\S]*Propositions/);
    const close = await cad(dir, 'session', 'close');
    expect(close.out).toMatch(/Faits propres au projet\n  fiche du jour absente\n  ✗ commande en échec \(code 3\)\n\n\(aucun motif[^\n]*\n\n✓ prêt à fermer/);
    // Des faits en plus, pas une condition : l'échec de la commande du projet ne change pas le verdict.
    expect(close.code).toBe(0);
  });

  it('refuse une clé session mal formée', async () => {
    const dir = await project();
    writeFileSync(join(dir, 'cadence.yaml'), 'session:\n  debut: x\n');
    const r = await cad(dir, 'session', 'start');
    expect(r.code).toBe(2);
    expect(r.err).toContain('session.debut');
  });

  it('sans clé session : rien de plus', async () => {
    const dir = await project();
    expect((await cad(dir, 'session', 'start')).out).not.toContain('Faits propres');
  });
});


describe('nettoyage en routine de clôture (L4)', () => {
  // Le ctime d'un fichier ne se fixe pas (voir CLEAN_TODAY) : la clôture se joue ici à un « aujourd'hui » lointain.
  const cadLate = async (dir: string, ...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, {
      cwd: dir,
      env: { RAF_TODAY: CLEAN_TODAY },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      now: () => new Date(`${CLEAN_TODAY}T18:30:00`),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const OLD = cleanAt(-18);
  const RECENT = cleanAt(-1);
  /**
   * Dépôt dont la clôture vaut 0 à CLEAN_TODAY : plan commité, aucun lot en cours (project() en laisse un
   * silencieux depuis 40 j, donc déjà « ✗ pas fermé »). Sert de référence aux tests « le nettoyage ne ferme
   * ni ne bloque » : une référence déjà à 1 laisserait survivre un nettoyage compté dans les points ouverts.
   */
  const closedProject = async () => {
    const dir = gitRepo();
    await cad(dir, 'init', '--project', 'demo', '--no-hook');
    await cad(dir, 'add', 'Cache');
    git(dir, 'add', '.');
    commit(dir, 'chore: plan', '2026-09-20T09:00:00');
    return dir;
  };
  /** Écrit le cadence.yaml du test et le commite : un fichier non commité serait lui-même un point ouvert. */
  const configure = (dir: string, yaml: string) => {
    writeFileSync(join(dir, 'cadence.yaml'), yaml);
    git(dir, 'add', 'cadence.yaml');
    commit(dir, 'chore: configuration', '2026-09-21T09:00:00');
  };
  const READY = /\n✓ prêt à fermer$/;
  const touch = (file: string, when: Date) => {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, 'x');
    utimesSync(file, when, when);
  };

  it('liste les fichiers périmés des motifs session.clean, sans rien supprimer ni bloquer la clôture', async () => {
    const dir = await closedProject();
    const shared = tempDir();
    touch(join(shared, 'ancienne-capture.png'), OLD);
    touch(join(shared, 'capture-du-jour.png'), RECENT);
    mkdirSync(join(shared, 'tmp-test-abc'));
    utimesSync(join(shared, 'tmp-test-abc'), OLD, OLD);
    const sans = await cadLate(dir, 'session', 'close');
    expect(sans.code).toBe(0);
    expect(sans.out).toMatch(READY);
    configure(dir, `session:\n  clean:\n    - "${shared}/*.png"\n    - "${shared}/tmp-test-*"\n`);
    const { code, out } = await cadLate(dir, 'session', 'close');
    expect(out).toMatch(/Nettoyage proposé \(2 élément\(s\) plus vieux de 7 j\)\n/);
    expect(out).toContain(`${join(shared, 'ancienne-capture.png')} — 18 j`);
    expect(out).toContain(`${join(shared, 'tmp-test-abc')} — 18 j`);
    expect(out).not.toContain('capture-du-jour');
    // Rien n'est supprimé : la commande propose, le skill demande l'accord.
    expect(existsSync(join(shared, 'ancienne-capture.png'))).toBe(true);
    // Une proposition, pas une condition de fermeture : la référence ferme à 0, le nettoyage proposé aussi.
    expect(code).toBe(0);
    expect(out).toMatch(READY);
    expect(out).not.toMatch(/✗/);
  });

  it('cleanDays règle le seuil ; un motif relatif part de la racine du dépôt ; ~ désigne le dossier personnel', async () => {
    const dir = await project();
    touch(join(dir, 'tmp/vieux.log'), cleanAt(-2));
    writeFileSync(join(dir, 'cadence.yaml'), 'session:\n  cleanDays: 1\n  clean: [ "tmp/*", "~/cadence-inexistant-xyz/*" ]\n');
    const { out } = await cadLate(dir, 'session', 'close');
    expect(out).toMatch(/Nettoyage proposé \(1 élément\(s\) plus vieux de 1 j\)/);
    expect(out).toContain(`${join(dir, 'tmp/vieux.log')} — 2 j`);
  });

  it('~ désigne le dossier personnel : un fichier périmé qui s’y trouve est listé', async () => {
    const dir = await project();
    const home = tempDir();
    touch(join(home, 'partage/tmp/ancienne.png'), OLD);
    writeFileSync(join(dir, 'cadence.yaml'), 'session:\n  clean: [ "~/partage/tmp/*" ]\n');
    const avant = process.env.HOME;
    process.env.HOME = home;
    try {
      const { out } = await cadLate(dir, 'session', 'close');
      expect(out).toMatch(/Nettoyage proposé \(1 élément\(s\)/);
      expect(out).toContain(`${join(home, 'partage/tmp/ancienne.png')} — 18 j`);
    } finally {
      if (avant === undefined) delete process.env.HOME;
      else process.env.HOME = avant;
    }
  });

  it('ne propose jamais un fichier suivi par git', async () => {
    const dir = await project();
    touch(join(dir, 'tmp/suivi.png'), OLD);
    touch(join(dir, 'tmp/libre.png'), OLD);
    git(dir, 'add', 'tmp/suivi.png');
    git(dir, 'commit', '-qm', 'chore: capture suivie');
    writeFileSync(join(dir, 'cadence.yaml'), 'session:\n  clean: [ "tmp/*" ]\n');
    const { out } = await cadLate(dir, 'session', 'close');
    expect(out).toContain('libre.png');
    expect(out).not.toContain('suivi.png');
  });

  it('ne propose jamais un fichier suivi par un autre dépôt git, même visé par un motif absolu', async () => {
    const dir = await project();
    const autre = gitRepo();
    touch(join(autre, 'suivi.png'), OLD);
    touch(join(autre, 'libre.png'), OLD);
    git(autre, 'add', 'suivi.png');
    git(autre, 'commit', '-qm', 'chore: capture suivie');
    writeFileSync(join(dir, 'cadence.yaml'), `session:\n  clean: [ "${autre}/*" ]\n`);
    const { out } = await cadLate(dir, 'session', 'close');
    expect(out).toContain('libre.png');
    expect(out).not.toContain('suivi.png');
  });

  it('un fichier suivi dont le nom commence par .. reste protégé', async () => {
    const dir = await project();
    touch(join(dir, '..weird'), OLD);
    touch(join(dir, 'tmp/libre.png'), OLD);
    git(dir, 'add', '..weird');
    git(dir, 'commit', '-qm', 'chore: fichier suivi');
    writeFileSync(join(dir, 'cadence.yaml'), 'session:\n  clean: [ "tmp/*", "..*" ]\n');
    const { out } = await cadLate(dir, 'session', 'close');
    expect(out).toContain('libre.png');
    expect(out).not.toContain('..weird');
  });

  it.skipIf(process.getuid?.() === 0)('un dossier illisible n’est pas proposé : il est signalé, sans bloquer ni faire lever la clôture', async () => {
    const dir = await closedProject();
    const shared = tempDir();
    mkdirSync(join(shared, 'ferme/clone'), { recursive: true });
    git(join(shared, 'ferme/clone'), 'init', '-q');
    touch(join(shared, 'ancienne.png'), OLD);
    utimesSync(join(shared, 'ferme'), OLD, OLD);
    configure(dir, `session:\n  clean: [ "${shared}/*" ]\n`);
    const sans = await cadLate(dir, 'session', 'close');
    expect(sans.code).toBe(0);
    expect(sans.out).toMatch(READY);
    chmodSync(join(shared, 'ferme'), 0o311);
    try {
      const { code, out } = await cadLate(dir, 'session', 'close');
      expect(out).toMatch(/Nettoyage proposé \(1 élément\(s\) plus vieux de 7 j\)\n {2}.*ancienne\.png — 18 j\n/);
      expect(out).toContain(`Nettoyage : 1 élément(s) illisible(s), jamais proposé(s)\n  ${join(shared, 'ferme')}`);
      // Illisible = signalé, pas compté : la référence ferme à 0, la clôture aussi.
      expect(code).toBe(0);
      expect(out).toMatch(READY);
    } finally {
      chmodSync(join(shared, 'ferme'), 0o755);
    }
  });

  it('sans session.clean : une seule ligne d’indice avec un exemple, sans bloquer la clôture', async () => {
    const dir = await closedProject();
    const { code, out } = await cadLate(dir, 'session', 'close');
    const lines = out.split('\n').filter((l) => l.includes('aucun motif de nettoyage déclaré'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('session.clean');
    expect(lines[0]).toContain('cleanDays');
    expect(lines[0]).toMatch(/tmp\/\*/);
    expect(lines[0]).toMatch(/~\//);
    expect(code).toBe(0);
    expect(out).toMatch(READY);
    // Un motif déclaré (même vide de périmés) supprime l'indice.
    configure(dir, 'session:\n  clean: [ "tmp/*" ]\n');
    expect((await cadLate(dir, 'session', 'close')).out).not.toContain('aucun motif');
  });

  it('avec session.clean vide (clean: []) : l’indice est aussi affiché, une seule fois', async () => {
    const dir = await closedProject();
    configure(dir, 'session:\n  clean: []\n');
    const { code, out } = await cadLate(dir, 'session', 'close');
    expect(out.split('\n').filter((l) => l.includes('aucun motif de nettoyage déclaré'))).toHaveLength(1);
    expect(out).not.toContain('Nettoyage');
    expect(code).toBe(0);
    expect(out).toMatch(READY);
  });

  it('aucune section sans motif, ni quand rien n’est périmé', async () => {
    const dir = await project();
    expect((await cadLate(dir, 'session', 'close')).out).not.toContain('Nettoyage');
    const shared = tempDir();
    touch(join(shared, 'frais.png'), RECENT);
    writeFileSync(join(dir, 'cadence.yaml'), `session:\n  clean: [ "${shared}/*" ]\n`);
    expect((await cadLate(dir, 'session', 'close')).out).not.toContain('Nettoyage');
  });

  it('refuse un clean ou un cleanDays mal formé', async () => {
    const dir = await project();
    writeFileSync(join(dir, 'cadence.yaml'), 'session:\n  clean: 3\n');
    expect((await cadLate(dir, 'session', 'close')).code).toBe(2);
    writeFileSync(join(dir, 'cadence.yaml'), 'session:\n  clean: [ "tmp/*" ]\n  cleanDays: 0\n');
    const r = await cadLate(dir, 'session', 'close');
    expect(r.code).toBe(2);
    expect(r.err).toContain('session.cleanDays');
  });

  it('la routine session-close demande l’accord avant de supprimer, chemins explicites', () => {
    const skill = readFileSync(join(SKILLS_DIR, 'session-close', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(skill).toContain('**Stale working files**');
    expect(skill).toContain('only after the human agrees');
    expect(skill).toContain('explicit paths');
  });

  it('README et routine session-close disent exactement ce qui n’est jamais proposé (L4/t10)', () => {
    const flat = (t: string) => t.replace(/\s+/g, ' ');
    const skill = flat(readFileSync(join(SKILLS_DIR, 'session-close', 'SKILL.md'), 'utf8'));
    const readme = flat(readFileSync(join(SKILLS_DIR, '..', 'README.md'), 'utf8'));
    const rule = 'An entry is proposed only if it could be measured entirely.';
    expect(readme).toContain(rule);
    expect(skill).toContain(rule);
    for (const never of [
      'a git repository, a folder that contains one at any depth, and anything under a `.git` folder',
      'anything `git` tracks, in any repository that has a `.git` entry above it',
      'a name starting with `.` unless the pattern itself starts that name with `.`',
      'anything that could not be read entirely',
    ]) {
      expect(readme).toContain(never);
      expect(skill).toContain(never);
    }
    expect(readme).toContain("a folder's age is that of the most recent entry it contains");
    expect(skill).toContain("a folder's age is that of the most recent entry it contains");
    expect(readme).toContain('Nettoyage : N élément(s) illisible(s), jamais proposé(s)');
    expect(skill).toContain('never delete those');
    // La limite du dépôt nu à arbre de travail externe est nommée des deux côtés (L4/t18).
    for (const t of [readme, skill]) {
      expect(t).toContain('--git-dir=~/.dotfiles --work-tree=~');
      expect(t).toContain('leaves no `.git` beside');
    }
    expect(readme).not.toContain('whichever repository');
    expect(skill).not.toContain('whichever repository');
  });

  it('la routine session-close relance le scan avant de supprimer et supprime un lien comme un lien (L4/t19)', () => {
    const skill = readFileSync(join(SKILLS_DIR, 'session-close', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(skill).toContain('right before deleting, re-run `cadence session close` (or the scan) and delete only the entries that are still proposed');
    expect(skill).toContain('Delete a proposed symbolic link as a link');
    expect(skill).toContain('never `rm -r` through it');
  });
});
