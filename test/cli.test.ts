import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureGitignore, run } from '../src/cli.js';
import { commit, gitRepo, tempDir } from './helpers.js';
import { projectEnv } from '../src/orchestrate/command.js';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-09-28' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-09-28T09:30:00'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('raf public', () => {
  it('add --public pose le titre public ; raf public le change et --clear l\'efface', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    expect(raf(dir, 'add', 'Titre', 'technique', '--visible', '--public', 'Une nouveauté').out).toBe('L1');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toContain('public: Une nouveauté');
    expect(raf(dir, 'public', 'L1', 'Autre', 'titre').code).toBe(0);
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toContain('public: Autre titre');
    expect(raf(dir, 'public', 'L1', '--clear').code).toBe(0);
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).not.toContain('public:');
  });

  it('raf public refuse sans titre ni --clear, et un lot inconnu', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'A');
    expect(raf(dir, 'public', 'L1').code).not.toBe(0);
    expect(raf(dir, 'public', 'L9', 'x').code).not.toBe(0);
    expect(raf(dir, 'add', 'B', '--parent', 'L1', '--public', 'x').code).not.toBe(0);
  });
});

describe('raf public --clear', () => {
  it('refuse --clear accompagné d\'un titre sans toucher au titre public existant', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'A', '--public', 'Existant');
    const avant = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    const r = raf(dir, 'public', 'L1', 'Titre', '--clear');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('--clear');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toBe(avant);
  });
});

describe('raf init : .gitignore', () => {
  it('init crée le .gitignore avec .playwright-mcp/ et sort en 0', () => {
    const dir = gitRepo();
    expect(raf(dir, 'init', '--no-hook').code).toBe(0);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.playwright-mcp/\n');
  });

  it('ensureGitignore : ajoute sans perdre le contenu, sans doublon, quelle que soit la variante déjà posée', () => {
    const cas: Array<[string, string | null, string, boolean]> = [
      ['fichier absent', null, '.playwright-mcp/\n', true],
      ['sans retour final', 'node_modules', 'node_modules\n.playwright-mcp/\n', true],
      ['avec retour final', 'node_modules\n', 'node_modules\n.playwright-mcp/\n', true],
      ['.playwright-mcp', '.playwright-mcp', '.playwright-mcp', false],
      ['/.playwright-mcp', '/.playwright-mcp\n', '/.playwright-mcp\n', false],
      ['.playwright-mcp/', '.playwright-mcp/\n', '.playwright-mcp/\n', false],
      ['variante sans retour final', 'a\n/.playwright-mcp', 'a\n/.playwright-mcp', false],
    ];
    for (const [nom, avant, apres, ecrit] of cas) {
      const dir = gitRepo();
      if (avant !== null) writeFileSync(join(dir, '.gitignore'), avant);
      expect(ensureGitignore(dir, '.playwright-mcp/'), nom).toBe(ecrit);
      expect(readFileSync(join(dir, '.gitignore'), 'utf8'), nom).toBe(apres);
      expect(ensureGitignore(dir, '.playwright-mcp/'), `${nom} (2e appel)`).toBe(false);
      expect(readFileSync(join(dir, '.gitignore'), 'utf8'), `${nom} (2e appel)`).toBe(apres);
    }
  });
});

describe('raf CLI', () => {
  it('runs a full lot lifecycle', () => {
    const dir = gitRepo();
    expect(raf(dir, 'init', '--project', 'demo').code).toBe(0);
    expect(existsSync(join(dir, 'docs/plan/raf.yaml'))).toBe(true);
    expect(raf(dir, 'add', 'Cache', 'des', 'prêts', '--estimate', '2').out).toBe('L1');
    expect(raf(dir, 'add', 'Petit', 'correctif', '--quickwin').out).toBe('L2');
    expect(raf(dir, 'add', 'Après', 'le', 'cache', '--after', 'L1').out).toBe('L3');
    expect(raf(dir, 'add', 'sous-tâche', '--parent', 'L1').out).toBe('L1/t1');
    expect(raf(dir, 'start', 'L1').code).toBe(0);
    commit(dir, 'feat(L1): cache', '2026-09-28T10:00:00');

    const now = raf(dir, 'now').out;
    expect(now).toMatch(/En cours\n {2}L1 {2}Cache des prêts {2}\(2 j, 1 commit\(s\), sous-tâches 0\/1\)/);
    expect(now.indexOf('⚡ L2')).toBeLessThan(now.indexOf('en attente'));
    expect(now).toContain('en attente de dépendances : L3');

    expect(raf(dir, 'done', 'L1').code).toBe(2);
    raf(dir, 'done', 'L1/t1');
    expect(raf(dir, 'done', 'L1').code).toBe(0);
    raf(dir, 'drop', 'L2', '--reason', 'plus utile');
    raf(dir, 'note', 'L3', 'à', 'découper');
    const yaml = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    expect(yaml).toContain('text: "abandonné : plus utile"');
    expect(yaml).toContain('text: à découper');
    expect(raf(dir, 'list', '--status', 'todo').out).toMatch(/^L3 +todo +Après le cache$/);
  });

  it('check exits 1 on drift and 0 when clean', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'A');
    commit(dir, 'feat(L1): a');
    expect(raf(dir, 'check').code).toBe(1);
    raf(dir, 'start', 'L1');
    const ok = raf(dir, 'check');
    expect(ok.out).toContain('cohérents');
    expect(ok.code).toBe(0);
  });

  it('reports usage errors with code 2', () => {
    const dir = gitRepo();
    expect(raf(dir, 'now').err).toMatch(/raf init/);
    raf(dir, 'init', '--no-hook');
    expect(raf(dir, 'add', 'x', '--estimate', 'abc').code).toBe(2);
    expect(raf(dir, 'frobnicate').err).toMatch(/commande inconnue/);
  });

  it('post-commit only talks, never writes', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'A');
    const before = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    commit(dir, 'feat(L1): a');
    expect(raf(dir, 'hook', 'post-commit').err).toContain('L1 est encore todo');
    commit(dir, 'wip');
    expect(raf(dir, 'hook', 'post-commit').err).toContain('commit sans lot');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toBe(before);
  });

  it('(L15/t2) post-commit : seule la portée décide des lots annoncés, pas les mentions en passage', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    for (let i = 0; i < 30; i++) raf(dir, 'add', `lot ${i + 1}`);
    raf(dir, 'start', 'L24');
    commit(dir, 'chore(L24): lot terminé — (L27) et (L28–L30) planifiés — voir L99');
    const { err } = raf(dir, 'hook', 'post-commit');
    expect(err).toContain('L24 (doing)');
    for (const id of ['L27', 'L28', 'L30', 'L99']) expect(err).not.toContain(id);
  });

  it('hook install keeps an existing hook and is idempotent', () => {
    const dir = gitRepo();
    const hook = join(dir, '.git/hooks/post-commit');
    writeFileSync(hook, '#!/bin/sh\necho existing\n');
    raf(dir, 'hook', 'install');
    expect(raf(dir, 'hook', 'install').out).toContain('déjà présent');
    const text = readFileSync(hook, 'utf8');
    expect(text.startsWith('#!/bin/sh\necho existing\n# >>> raf')).toBe(true);
    expect(text.match(/>>> raf/g)).toHaveLength(1);
    expect(statSync(hook).mode & 0o111).not.toBe(0);
  });

  it('gantt writes a self-contained page with escaped data', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook', '--project', 'demo');
    raf(dir, 'add', '</script><img src=x onerror=alert(1)>');
    const path = raf(dir, 'gantt').out;
    const html = readFileSync(path, 'utf8');
    expect(path).toBe(join(dir, 'docs/plan/gantt.html'));
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org)/);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    const json = /<script type="application\/json" id="raf-data">(.*?)<\/script>/s.exec(html)![1];
    const data = JSON.parse(json);
    expect(data.bars[0]).toMatchObject({ id: 'L1', start: '2026-09-28', end: '2026-09-28', projected: true });
    expect(data.generated).toBe('2026-09-28 09:30');
  });
});

describe('adoption date', () => {
  it('check ignores commits made before raf init', () => {
    const dir = gitRepo();
    commit(dir, 'feat: ancien travail', '2026-09-20T10:00:00');
    raf(dir, 'init', '--no-hook');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toContain('since: 2026-09-28');
    expect(raf(dir, 'check').code).toBe(0);
    commit(dir, 'feat: nouveau travail sans lot', '2026-09-28T08:00:00');
    expect(raf(dir, 'check').out).toContain('commit sans lot');
  });
});

describe('plan-only commits', () => {
  it('do not need to cite a lot', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'A');
    execFileSync('git', ['add', 'docs/plan/raf.yaml'], { cwd: dir });
    commit(dir, 'chore: plan raf');
    expect(raf(dir, 'check').code).toBe(0);
    expect(raf(dir, 'hook', 'post-commit').err).toBe('');
    writeFileSync(join(dir, 'x.txt'), 'x');
    execFileSync('git', ['add', 'x.txt'], { cwd: dir });
    commit(dir, 'chore: autre chose');
    expect(raf(dir, 'check').out).toContain('commit sans lot : ');
  });
});

describe('(L94) --config hors du dépôt, qa.expectations absolu dans le dépôt', () => {
  it('raf check accepte le chemin absolu, lu depuis la racine du dépôt de travail, et le fichier est tenu avec le plan', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    raf(dir, 'add', 'A');
    execFileSync('git', ['add', 'docs/plan/raf.yaml'], { cwd: dir });
    commit(dir, 'chore: plan raf');
    mkdirSync(join(dir, 'docs/quality'), { recursive: true });
    writeFileSync(join(dir, 'docs/quality/pages.md'), 'attendus\n');
    execFileSync('git', ['add', 'docs/quality/pages.md'], { cwd: dir });
    commit(dir, 'docs(qa): attendus');
    const outside = tempDir();
    const config = join(outside, 'cadence.yaml');
    writeFileSync(config, `qa:\n  expectations: ${join(dir, 'docs/quality/pages.md')}\n`);
    const r = raf(dir, 'check', '--config', config);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('commit sans lot');
    // sans la config, le même fichier est un fichier comme un autre : le commit est sans lot
    expect(raf(dir, 'check').out).toContain('commit sans lot');
  });

  it('un chemin absolu hors du dépôt de travail reste refusé', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    const outside = tempDir();
    const config = join(outside, 'cadence.yaml');
    writeFileSync(config, `qa:\n  expectations: ${join(outside, 'pages.md')}\n`);
    const r = raf(dir, 'check', '--config', config);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('hors du dépôt');
  });

  // Ne prouve PAS que `repo` est transmis à readPlanConfig (command.ts:127) : configPath y vaut toujours
  // join(repo, 'cadence.yaml'), le repli gitRoot(dirname(file)) donne la même racine. Verrouille seulement
  // le résultat : un chemin absolu dans le dépôt est ramené en relatif. À compléter si projectEnv lit un jour
  // un cadence.yaml hors du dépôt.
  it("projectEnv (orchestrate) ramène un qa.expectations absolu dans le dépôt en relatif (la transmission de la racine n'est pas discriminée)", () => {
    const dir = gitRepo();
    raf(dir, 'init', '--no-hook');
    writeFileSync(join(dir, 'cadence.yaml'), `qa:\n  expectations: ${join(dir, 'docs/quality/pages.md')}\n`);
    const env = projectEnv(dir);
    expect(env.loadPlan().qaExpectations).toBe('docs/quality/pages.md');
  });
});

describe('raf show', () => {
  function planAvecLot() {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'Base');
    raf(dir, 'add', 'Titre technique', '--public', 'Une nouveauté', '--after', 'L1');
    raf(dir, 'start', 'L2');
    raf(dir, 'note', 'L2', 'première', 'note');
    raf(dir, 'note', 'L2', 'seconde note');
    commit(dir, 'feat(L2): premier', '2026-09-28T10:00:00');
    commit(dir, 'feat(L2): second', '2026-09-28T11:00:00');
    return dir;
  }

  it('affiche identifiant, statut, dates, after, titre public, notes dans l\'ordre, puis les commits comptés', () => {
    const dir = planAvecLot();
    const r = raf(dir, 'show', 'L2');
    expect(r.code).toBe(0);
    const lignes = r.out.split('\n');
    expect(lignes[0]).toBe('L2  doing  Titre technique');
    expect(r.out).toContain('after : L1');
    expect(r.out).toContain('public : Une nouveauté');
    expect(r.out).toContain('créé : 2026-09-28');
    expect(r.out).toContain('démarré : 2026-09-28');
    expect(r.out.indexOf('première note')).toBeGreaterThan(-1);
    expect(r.out.indexOf('première note')).toBeLessThan(r.out.indexOf('seconde note'));
    expect(r.out).toContain('2026-09-28  première note');
    expect(r.out).toContain('commits (2)');
    expect(r.out.indexOf('feat(L2): premier')).toBeLessThan(r.out.indexOf('feat(L2): second'));
    expect(r.out.indexOf('seconde note')).toBeLessThan(r.out.indexOf('commits (2)'));
  });

  it('les lignes suivantes d\'une note sur plusieurs lignes restent sous « notes : », sous le texte', () => {
    const dir = planAvecLot();
    raf(dir, 'note', 'L2', 'ligne un\nligne deux');
    const r = raf(dir, 'show', 'L2');
    expect(r.out).toContain('  2026-09-28  ligne un\n              ligne deux\n');
    expect(r.out.split('\n').filter((l) => l && !l.startsWith(' ') && !/^(L2 |créé|after|public|notes|commits)/.test(l))).toEqual([]);
  });

  it('l\'aide et le README ne promettent pas « en entier » : ils listent ce que show affiche', () => {
    const aide = raf(gitRepo(), '--help').out;
    expect(aide).not.toContain('en entier');
    expect(readFileSync(join(__dirname, '..', 'README.md'), 'utf8')).not.toMatch(/raf show[^\n]*in full/);
  });

  it('--notes n\'affiche que les notes, une par ligne', () => {
    const dir = planAvecLot();
    const r = raf(dir, 'show', 'L2', '--notes');
    expect(r.code).toBe(0);
    expect(r.out).toBe('2026-09-28  première note\n2026-09-28  seconde note');
  });

  it('un lot sans after ni titre public ni note ni commit masque ces lignes et affiche « commits (0) : »', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'Base');
    const r = raf(dir, 'show', 'L1');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('after :');
    expect(r.out).not.toContain('public :');
    expect(r.out).not.toContain('notes :');
    expect(r.out).not.toContain('terminé');
    expect(r.out).toContain('commits (0) :');
  });

  it('un lot terminé affiche la date « terminé : … »', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'Base');
    raf(dir, 'start', 'L1');
    commit(dir, 'feat(L1): fait', '2026-09-28T10:00:00');
    const d = raf(dir, 'done', 'L1');
    expect(d.code, d.err).toBe(0);
    const r = raf(dir, 'show', 'L1');
    expect(r.out).toContain('créé : 2026-09-28  démarré : 2026-09-28  terminé : 2026-09-28');
    expect(r.out.split('\n')[0]).toContain('done');
  });

  it('un lot abandonné ne se dit pas « terminé »', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'Base');
    const d = raf(dir, 'drop', 'L1', '--reason', 'plus utile');
    expect(d.code, d.err).toBe(0);
    const r = raf(dir, 'show', 'L1');
    expect(r.out).toContain('dropped');
    expect(r.out).toContain('créé : 2026-09-28  abandonné : 2026-09-28');
    expect(r.out).not.toContain('terminé');
  });

  it('refuse un lot inconnu et une sous-tâche', () => {
    const dir = planAvecLot();
    expect(raf(dir, 'show', 'L9').err).toContain('lot inconnu');
    expect(raf(dir, 'show', 'L2/t1').code).not.toBe(0);
    expect(raf(dir, 'show').code).not.toBe(0);
  });
});

describe('lot visible sans titre public (L32)', () => {
  const setup = () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    return dir;
  };

  it('raf check avertit sans échouer : code 0, ligne ⚠, compte d\'avertissements', () => {
    const dir = setup();
    raf(dir, 'add', 'A', '--visible');
    const r = raf(dir, 'check');
    expect(r.code).toBe(0);
    expect(r.out).toContain('⚠ L1 : lot visible sans titre public');
    expect(r.out).not.toContain('✗');
    expect(r.out).toContain('1 avertissement(s)');
  });

  it('se tait avec un titre public, pour un lot non visible et pour un lot abandonné', () => {
    const dir = setup();
    raf(dir, 'add', 'A', '--visible', '--public', 'Une nouveauté');
    raf(dir, 'add', 'B');
    raf(dir, 'add', 'C', '--visible');
    raf(dir, 'drop', 'L3');
    const r = raf(dir, 'check');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('sans titre public');
    expect(r.out).toContain('✓ plan et historique cohérents');
  });

  it('un vrai écart fait toujours échouer et les deux se comptent séparément', () => {
    const dir = setup();
    raf(dir, 'add', 'A', '--visible');
    raf(dir, 'done', 'L1', '--force');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('⚠ L1');
    expect(r.out).toMatch(/1 écart\(s\), 1 avertissement\(s\)/);
  });

  it('se tait pour un lot terminé dont une Nouveauté fournit le titre que le site affiche', () => {
    const dir = setup();
    raf(dir, 'add', 'A', '--visible');
    raf(dir, 'done', 'L1', '--force');
    mkdirSync(join(dir, 'docs/nouveautes'), { recursive: true });
    writeFileSync(join(dir, 'docs/nouveautes/2026-10-07-x.md'), '---\ntitle: Titre lisible\ndate: 2026-10-07\ncreated: 2026-10-07T10:00:00+02:00\nlots: [L1]\ncaptures: []\nnocapture: test\n---\ncorps\n');
    const r = raf(dir, 'check');
    expect(r.out).not.toContain('sans titre public');
    expect(r.out).not.toContain('avertissement');
  });

  it('avertit encore pour un lot visible en cours cité par une Nouveauté (le site ne reprend le titre qu\'une fois terminé)', () => {
    const dir = setup();
    raf(dir, 'add', 'A', '--visible');
    mkdirSync(join(dir, 'docs/nouveautes'), { recursive: true });
    writeFileSync(join(dir, 'docs/nouveautes/2026-10-07-x.md'), '---\ntitle: Titre lisible\ndate: 2026-10-07\ncreated: 2026-10-07T10:00:00+02:00\nlots: [L1]\ncaptures: []\nnocapture: test\n---\ncorps\n');
    expect(raf(dir, 'check').out).toContain('⚠ L1 : lot visible sans titre public');
  });
});

describe('titre public trop long (L106)', () => {
  const long = 'x'.repeat(88);
  const setup = (yaml?: string) => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    if (yaml !== undefined) writeFileSync(join(dir, 'cadence.yaml'), yaml);
    raf(dir, 'add', 'A', '--visible');
    return dir;
  };

  it('raf public, add --public et news new refusent au-delà de news.publicTitleMax', () => {
    const dir = setup('news:\n  publicTitleMax: 80\n');
    const r = raf(dir, 'public', 'L1', long);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('88');
    expect(r.err).toContain('80');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).not.toContain('public:');
    expect(raf(dir, 'add', 'B', '--public', long).code).not.toBe(0);
    expect(raf(dir, 'news', 'new', 'L1', '--title', long).code).not.toBe(0);
    expect(raf(dir, 'public', 'L1', 'y'.repeat(80)).code).toBe(0);
    expect(raf(dir, 'news', 'new', 'L1', '--title', 'z'.repeat(80)).code).toBe(0);
  });

  it('raf done refuse un lot dont le titre public dépasse la limite déclarée', () => {
    const dir = setup();
    expect(raf(dir, 'public', 'L1', long).code).toBe(0); // sans clé : rien n'est refusé
    expect(raf(dir, 'done', 'L1').code).toBe(0);
    const dir2 = setup('news:\n  publicTitleMax: 60\n');
    writeFileSync(join(dir2, 'docs/plan/raf.yaml'), readFileSync(join(dir2, 'docs/plan/raf.yaml'), 'utf8').replace('title: A', `title: A\n    public: ${'y'.repeat(70)}`));
    const r = raf(dir2, 'done', 'L1');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('70');
    expect(readFileSync(join(dir2, 'docs/plan/raf.yaml'), 'utf8')).not.toContain('status: done');
  });

  it('raf check ne signale rien sans clé déclarée ni dossier de Nouveautés : aucun site ne publie ce titre', () => {
    const dir = setup();
    raf(dir, 'public', 'L1', long);
    expect(raf(dir, 'check').out).not.toContain('titre public');
  });

  it('raf check signale, avec 80 par défaut sans clé, dans un projet qui publie des Nouveautés', () => {
    const dir = setup();
    mkdirSync(join(dir, 'docs/nouveautes'), { recursive: true });
    raf(dir, 'public', 'L1', long);
    const r = raf(dir, 'check');
    expect(r.out).toContain('L1');
    expect(r.out).toContain('titre public');
    expect(r.out).toContain('88');
    raf(dir, 'public', 'L1', 'court');
    expect(raf(dir, 'check').out).not.toContain('titre public');
  });

  it('la clé news.publicTitleMax règle aussi le seuil de raf check', () => {
    const dir = setup('news:\n  publicTitleMax: 100\n');
    raf(dir, 'public', 'L1', long);
    expect(raf(dir, 'check').out).not.toContain('titre public');
  });

  it('la clé déclarée l\'emporte sur l\'absence du dossier de Nouveautés : raf check signale même sans docs/nouveautes', () => {
    const dir = setup('news:\n  publicTitleMax: 60\n');
    // raf public refuse lui-même au-delà de la clé : le public: s'écrit à la main, comme un titre venu d'ailleurs
    writeFileSync(join(dir, 'docs/plan/raf.yaml'), readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8').replace('title: A', `title: A\n    public: ${'z'.repeat(70)}`));
    const r = raf(dir, 'check');
    expect(r.out).toContain('L1');
    expect(r.out).toContain('70');
    expect(r.out).toContain('titre public');
  });

  const entreeLongue = (dir: string, title = long) => {
    mkdirSync(join(dir, 'docs/nouveautes'), { recursive: true });
    writeFileSync(join(dir, 'docs/nouveautes/2026-10-07-x.md'), `---\ntitle: ${title}\ndate: 2026-10-07\ncreated: 2026-10-07T10:00:00+02:00\nlots: [L1]\ncaptures: []\nnocapture: test\n---\ncorps\n`);
  };

  it('raf check signale le titre repris de la Nouveauté d\'un lot visible terminé sans public (cas ccc L32)', () => {
    const dir = setup();
    raf(dir, 'done', 'L1', '--force');
    entreeLongue(dir);
    const r = raf(dir, 'check');
    expect(r.out).toContain('L1');
    expect(r.out).toContain('88');
    expect(r.out).toContain('Nouveauté');
    raf(dir, 'public', 'L1', 'court'); // un public: l'emporte sur le titre de la Nouveauté
    expect(raf(dir, 'check').out).not.toContain('88 caractères');
  });

  it('raf check ne signale pas la Nouveauté longue d\'un lot non visible, ni d\'un lot visible pas terminé', () => {
    const dir = setup('news:\n  publicTitleMax: 80\n');
    raf(dir, 'add', 'B'); // L2, non visible
    entreeLongue(dir);
    writeFileSync(join(dir, 'docs/nouveautes/2026-10-07-y.md'), readFileSync(join(dir, 'docs/nouveautes/2026-10-07-x.md'), 'utf8').replace('[L1]', '[L2]'));
    expect(raf(dir, 'done', 'L2', '--force').code).toBe(0);
    expect(raf(dir, 'check').out).not.toContain('88 caractères'); // L1 visible mais pas terminé, L2 terminé mais non visible
  });

  it('raf done accepte un lot non visible dont une Nouveauté citée est longue', () => {
    const dir = setup('news:\n  publicTitleMax: 80\n');
    raf(dir, 'add', 'B'); // L2, non visible
    entreeLongue(dir);
    writeFileSync(join(dir, 'docs/nouveautes/2026-10-07-y.md'), readFileSync(join(dir, 'docs/nouveautes/2026-10-07-x.md'), 'utf8').replace('[L1]', '[L2]'));
    expect(raf(dir, 'done', 'L2', '--force').code).toBe(0);
  });

  it('raf done refuse un lot visible dont la Nouveauté, reprise par le site, dépasse la limite déclarée', () => {
    const dir = setup('news:\n  publicTitleMax: 80\n');
    entreeLongue(dir);
    const r = raf(dir, 'done', 'L1', '--force');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('88');
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).not.toContain('status: done');
    raf(dir, 'public', 'L1', 'court');
    expect(raf(dir, 'done', 'L1', '--force').code).toBe(0);
  });

  it('news new sans --title refuse un titre de lot trop long et propose --title', () => {
    const dir = setup('news:\n  publicTitleMax: 80\n');
    writeFileSync(join(dir, 'docs/plan/raf.yaml'), readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8').replace('title: A', `title: ${long}`));
    const r = raf(dir, 'news', 'new', 'L1');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('--title');
    expect(raf(dir, 'news', 'new', 'L1', '--title', 'court').code).toBe(0);
  });

  it('news new mesure le titre après fusion des espaces', () => {
    const dir = setup('news:\n  publicTitleMax: 80\n');
    const t = `${'a'.repeat(40)}${' '.repeat(30)}${'b'.repeat(40)}`; // 110 brut, 81 fusionné
    expect(raf(dir, 'news', 'new', 'L1', '--title', t).code).not.toBe(0);
    const ok = `${'a'.repeat(40)}${' '.repeat(30)}${'b'.repeat(39)}`; // 80 fusionné
    expect(raf(dir, 'news', 'new', 'L1', '--title', ok).code).toBe(0);
  });

  it('news new écrit un titre de plus de 80 caractères sur une seule ligne', () => {
    const dir = setup();
    const titre = Array.from({ length: 16 }, (_, i) => `mot${i}`).join(' '); // > 80, avec espaces
    const r = raf(dir, 'news', 'new', 'L1', '--title', titre);
    expect(r.code, r.err).toBe(0);
    const f = readFileSync(r.out.trim(), 'utf8');
    expect(f.split('\n').find((l) => l.startsWith('title:'))).toBe(`title: ${titre}`);
    expect(f.split('\n')[2]).toMatch(/^date:/);
  });
});
