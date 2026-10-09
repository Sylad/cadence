import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
    expect(out).toMatch(/Commits de la période \(depuis 2026-09-28 00:00\)\n {2}1 commit\(s\) sans lot :\n {4}[0-9a-f]{7} wip sans lot/);
    expect(out).toContain('L1  Cache — aucun commit sur la période : raf done ou raf note');
    expect(out).toContain('1 fichier(s) modifié(s)');
    expect(out).toMatch(/✗ pas fermé : \d+ point\(s\)/);
  });

  it('un commit acquitté par raf ignore ne compte plus comme « sans lot » (ni à la clôture)', async () => {
    const dir = await project();
    commit(dir, 'chore: .gitignore', '2026-09-28T11:00:00');
    expect((await cad(dir, 'session', 'close')).out).toContain('sans lot');
    expect((await cad(dir, 'ignore', 'chore: .gitignore', '--reason', 'outillage')).code).toBe(0);
    expect((await cad(dir, 'session', 'close')).out).not.toContain('sans lot');
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

describe('session close : fenêtre depuis la dernière ouverture (issue #7)', () => {
  it("couvre la période depuis l'ouverture, la dit, et ne relit pas ce que l'ouverture avait déjà rapporté", async () => {
    const dir = await project();
    commit(dir, 'feat(L1): du matin', '2026-09-28T08:00:00');
    await cad(dir, 'session', 'start', '--since', '2026-09-27');
    const stamp = new Date('2026-09-28T18:30:00');
    expect(JSON.parse(readFileSync(join(stateDir(dir), 'session.json'), 'utf8'))).toMatchObject({ kind: 'start', at: stamp.toISOString() });
    // L'ouverture a eu lieu à 18:30 dans ce test ; on la recule à 09:12 pour simuler la matinée.
    writeFileSync(join(stateDir(dir), 'session.json'), JSON.stringify({ kind: 'start', at: new Date('2026-09-28T09:12:00').toISOString() }));
    commit(dir, 'feat(L2): de l\'après-midi', '2026-09-28T14:00:00');
    const { out } = await cad(dir, 'session', 'close');
    expect(out).toContain("Commits de la période (depuis l'ouverture de 09:12)");
    expect(out).toContain("feat(L2): de l'après-midi");
    expect(out).not.toContain('du matin');
  });

  it('--since garde la main et le dit', async () => {
    const dir = await project();
    commit(dir, 'feat(L1): du matin', '2026-09-28T08:00:00');
    writeFileSync(join(stateDir(dir), 'session.json'), JSON.stringify({ kind: 'start', at: new Date('2026-09-28T09:12:00').toISOString() }));
    const { out } = await cad(dir, 'session', 'close', '--since', '2026-09-01');
    expect(out).toContain('Commits de la période (depuis 2026-09-01)');
    expect(out).toContain('du matin');
  });

  it("sans ouverture connue : le jour même, dit comme tel", async () => {
    const dir = await project();
    const { out } = await cad(dir, 'session', 'close');
    expect(out).toContain('Commits de la période (depuis 2026-09-28 00:00)');
  });

  it("une clôture, réussie ou refusée, ne bouge pas la borne : relancée sans ouverture entre-temps, elle rapporte encore depuis l'ouverture", async () => {
    const dir = await project();
    writeFileSync(join(stateDir(dir), 'session.json'), JSON.stringify({ kind: 'start', at: new Date('2026-09-28T09:12:00').toISOString() }));
    writeFileSync(join(dir, 'x.txt'), 'x');
    git(dir, 'add', 'x.txt');
    expect((await cad(dir, 'session', 'close')).code).toBe(1);
    expect(JSON.parse(readFileSync(join(stateDir(dir), 'session.json'), 'utf8')).kind).toBe('start');
    git(dir, 'reset', '-q');
    rmSync(join(dir, 'x.txt'));
    await cad(dir, 'done', 'L1');
    git(dir, 'commit', '-qam', 'chore: plan');
    const origin = tempDir();
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    expect((await cad(dir, 'session', 'close')).code).toBe(0);
    expect(JSON.parse(readFileSync(join(stateDir(dir), 'session.json'), 'utf8')).kind).toBe('start');
    expect((await cad(dir, 'session', 'close')).out).toContain("Commits de la période (depuis l'ouverture de 09:12)");
  });

  it('CADENCE_SINCE vaut l\'instant ISO (UTC) de la marque sans --since, et la valeur donnée avec --since', async () => {
    const dir = await project();
    writeFileSync(join(dir, 'cadence.yaml'), 'session:\n  close: echo "since=$CADENCE_SINCE"\n');
    const at = new Date('2026-09-28T09:12:00');
    writeFileSync(join(stateDir(dir), 'session.json'), JSON.stringify({ kind: 'start', at: at.toISOString() }));
    expect((await cad(dir, 'session', 'close')).out).toContain(`  since=${at.toISOString()}\n`);
    expect((await cad(dir, 'session', 'close', '--since', '2026-09-01')).out).toContain('  since=2026-09-01\n');
  });

  it("une marque d'un autre jour est datée : du AAAA-MM-JJ à HH:MM, mois et jour sur deux chiffres", async () => {
    const dir = await project();
    writeFileSync(join(stateDir(dir), 'session.json'), JSON.stringify({ kind: 'start', at: new Date('2026-09-05T09:07:00').toISOString() }));
    expect((await cad(dir, 'session', 'close')).out).toContain("Commits de la période (depuis l'ouverture du 2026-09-05 à 09:07)");
  });

  it("un fichier d'état illisible retombe sur le jour même", async () => {
    const dir = await project();
    writeFileSync(join(stateDir(dir), 'session.json'), '{pas du json');
    expect((await cad(dir, 'session', 'close')).out).toContain('depuis 2026-09-28 00:00');
  });
});

describe('session next', () => {
  it('dit ce qui est enregistré, lignes telles qu’écrites (issue #6)', async () => {
    const dir = await project();
    const r = await cad(dir, 'session', 'next', 'finir L1', ' ', 'relire L2');
    expect(r.code).toBe(0);
    expect(r.out).toBe('2 lignes enregistrées pour la prochaine ouverture\n  - finir L1\n  - relire L2');
    const one = await cad(dir, 'session', 'next', 'finir L1');
    expect(one.out).toBe('1 ligne enregistrée pour la prochaine ouverture\n  - finir L1');
  });

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

  it('un avertissement (lot visible sans titre public) s\'affiche en ⚠ et n\'empêche pas « prêt à fermer »', async () => {
    const dir = await closedProject();
    await cad(dir, 'add', 'Vitrine', '--visible');
    git(dir, 'add', '.');
    commit(dir, 'chore: plan', '2026-09-21T09:00:00');
    const close = await cadLate(dir, 'session', 'close');
    expect(close.out).toContain('⚠ L2 : lot visible sans titre public');
    expect(close.out).not.toContain('✗ L2');
    expect(close.out).toMatch(READY);
    const start = await cad(dir, 'session', 'start', '--since', '2026-09-27');
    expect(start.out).toContain('⚠ L2 : lot visible sans titre public');
    expect(start.out).not.toContain('✗ L2');
    const now = await cad(dir, 'now');
    expect(now.out).not.toContain("entre le plan et l'historique");
  });

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

describe('session context (L148)', () => {
  const NOW = '2026-09-28T18:30:00';
  const at = new Date(NOW).getTime();

  async function ctxRun(dir: string, home: string, extra: string[] = [], env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['session', 'context', ...extra], { cwd: dir, env: { CADENCE_HOME: home, ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(NOW) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  /** Ce que la bande d'une session publie : un fichier par session dans <home>/hud-context/. */
  function publish(home: string, id: string, body: Record<string, unknown>) {
    mkdirSync(join(home, 'hud-context'), { recursive: true });
    writeFileSync(join(home, 'hud-context', `${id}.json`), JSON.stringify(body));
  }

  it('lit le chiffre que la bande publie pour le dossier courant, hors de tout dépôt', async () => {
    const home = tempDir();
    const dir = tempDir();
    publish(home, 'lead', { cwd: dir, percent: 42.4, tokens: 84000, window: 200000, at: at - 5_000 });
    const r = await ctxRun(dir, home);
    expect(r.code).toBe(0);
    expect(r.out).toBe('ctx 42 % (84000/200000)');
  });

  it('deux sessions écrivent : celle du dossier courant est choisie, jamais une autre', async () => {
    const home = tempDir();
    const lead = tempDir();
    const other = tempDir();
    publish(home, 'lead', { cwd: lead, percent: 70, tokens: 140000, window: 200000, at: at - 20_000 });
    publish(home, 'autre', { cwd: other, percent: 15, tokens: 30000, window: 200000, at: at - 1_000 });
    expect((await ctxRun(lead, home)).out).toBe('ctx 70 % (140000/200000)');
    expect((await ctxRun(other, home)).out).toBe('ctx 15 % (30000/200000)');
  });

  it('CLAUDE_CODE_SESSION_ID posée : sa session, même quand une autre du même dossier est plus récente', async () => {
    const home = tempDir();
    const dir = tempDir();
    publish(home, 'a', { cwd: dir, percent: 10, tokens: 1, window: 2, at: at - 40_000 });
    publish(home, 'b', { cwd: dir, percent: 55, tokens: 3, window: 4, at: at - 3_000 });
    expect((await ctxRun(dir, home, [], { CLAUDE_CODE_SESSION_ID: 'a' })).out).toBe('ctx 10 % (1/2)');
    expect((await ctxRun(dir, home, [], { CLAUDE_CODE_SESSION_ID: 'b' })).out).toBe('ctx 55 % (3/4)');
    // --session l'emporte sur la variable
    expect((await ctxRun(dir, home, ['--session', 'b'], { CLAUDE_CODE_SESSION_ID: 'a' })).out).toBe('ctx 55 % (3/4)');
    // la variable désigne une session sans fichier : refus, pas de repli sur le dossier
    const lost = await ctxRun(dir, home, [], { CLAUDE_CODE_SESSION_ID: 'muette' });
    expect(lost.code).toBe(2);
    expect(lost.err).toContain('CLAUDE_CODE_SESSION_ID');
  });

  it('variable absente et deux sessions fraîches dans le même dossier : refus qui demande --session', async () => {
    const home = tempDir();
    const dir = tempDir();
    publish(home, 'a', { cwd: dir, percent: 10, tokens: 1, window: 2, at: at - 40_000 });
    publish(home, 'b', { cwd: dir, percent: 55, tokens: 3, window: 4, at: at - 3_000 });
    const r = await ctxRun(dir, home);
    expect(r.code).toBe(2);
    expect(r.err).toContain('plusieurs sessions dans ce dossier');
    expect(r.err).toContain('--session');
    // une session périmée du même dossier (close) n'est pas une rivale
    publish(home, 'b', { cwd: dir, percent: 55, tokens: 3, window: 4, at: at - 3_000_000 });
    expect((await ctxRun(dir, home)).out).toBe('ctx 10 % (1/2)');
  });

  it('--session force la session, même si son dossier n\'est pas le dossier courant', async () => {
    const home = tempDir();
    publish(home, 'lead', { cwd: '/ailleurs', percent: 61, tokens: 5, window: 6, at: at - 2_000 });
    const r = await ctxRun(tempDir(), home, ['--session', 'lead']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('ctx 61 % (5/6)');
    const none = await ctxRun(tempDir(), home, ['--session', 'inconnue']);
    expect(none.code).toBe(2);
    expect(none.err).toContain('inconnue');
  });

  it('aucun fichier ou aucune session de ce dossier : refus (code 2) qui le dit, à lire comme « au seuil »', async () => {
    const home = tempDir();
    const none = await ctxRun(tempDir(), home);
    expect(none.code).toBe(2);
    expect(none.err).toContain('au seuil');
    expect(none.err).toContain('cadence-hud');
    publish(home, 'autre', { cwd: tempDir(), percent: 15, tokens: 1, window: 2, at: at - 1_000 });
    const dir = tempDir();
    const elsewhere = await ctxRun(dir, home);
    expect(elsewhere.code).toBe(2);
    expect(elsewhere.err).toContain(`aucune session de la bande ne publie pour ${dir}`);
  });

  it('périmé (plus de 2 min) : refus ; plus de 24 h : ignoré et supprimé à la lecture', async () => {
    const home = tempDir();
    const dir = tempDir();
    publish(home, 'lead', { cwd: dir, percent: 10, tokens: 1, window: 2, at: at - 600_000 });
    const old = await ctxRun(dir, home);
    expect(old.code).toBe(2);
    expect(old.err).toContain('périmé');
    publish(home, 'vieille', { cwd: dir, percent: 99, tokens: 1, window: 2, at: at - 25 * 3600_000 });
    publish(home, 'lead', { cwd: dir, percent: 20, tokens: 1, window: 2, at: at - 1_000 });
    const r = await ctxRun(dir, home);
    expect(r.out).toBe('ctx 20 % (1/2)');
    expect(existsSync(join(home, 'hud-context', 'vieille.json'))).toBe(false);
    expect(existsSync(join(home, 'hud-context', 'lead.json'))).toBe(true);
  });

  it('incomplet (tokens absent) : refus, le lead ne enchaîne pas', async () => {
    const home = tempDir();
    const dir = tempDir();
    publish(home, 'lead', { cwd: dir, percent: 30, window: 200000, at: at - 1_000 });
    const r = await ctxRun(dir, home);
    expect(r.code).toBe(2);
    expect(r.err).toContain('incomplet');
  });

  it('illisible : refus, par session désignée comme par dossier', async () => {
    const home = tempDir();
    const dir = tempDir();
    mkdirSync(join(home, 'hud-context'), { recursive: true });
    writeFileSync(join(home, 'hud-context', 'lead.json'), '{pas du json');
    const forced = await ctxRun(dir, home, ['--session', 'lead']);
    expect(forced.code).toBe(2);
    expect(forced.err).toContain('illisible');
    const byFolder = await ctxRun(dir, home);
    expect(byFolder.code).toBe(2);
    expect(byFolder.err).toContain('1 fichier(s) illisible(s)');
  });

  it("le script d'écriture de la bande et la lecture de la commande tombent sur le même fichier", async () => {
    const source = readFileSync(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url), 'utf8');
    const writer = /CONTEXT_WRITER = `([^`]*)`/.exec(source)?.[1];
    expect(writer).toBeDefined();
    const home = tempDir();
    const dir = tempDir();
    const body = JSON.stringify({ session: 'a/b c', cwd: dir, percent: 33, tokens: 7, window: 9, at: at - 1_000 });
    execFileSync('python3', ['-I', '-c', writer!, body], { env: { ...process.env, CADENCE_HOME: home } });
    expect(existsSync(join(home, 'hud-context', 'a_b_c.json'))).toBe(true);
    expect((await ctxRun(dir, home)).out).toBe('ctx 33 % (7/9)');
    expect((await ctxRun(tempDir(), home, ['--session', 'a/b c'])).out).toBe('ctx 33 % (7/9)');
  });
});
