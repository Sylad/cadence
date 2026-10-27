import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const NAME = 'acme-tool';
const LOCK_ROOT = { name: NAME, version: '1.2.3', dependencies: { yaml: '^2.5.0' }, devDependencies: { vitest: '^2.0.0' } };

const PACKAGE = `{
  "name": "${NAME}",
  "version": "1.2.3",
  "scripts": { "eval:plugin": "claude plugin eval ." },
  "dependencies": { "yaml": "^2.5.0" },
  "devDependencies": { "vitest": "^2.0.0" }
}
`;
const LOCK = `${JSON.stringify({
  name: NAME,
  version: '1.2.3',
  lockfileVersion: 3,
  packages: { '': LOCK_ROOT, 'node_modules/yaml': { version: '2.5.0' } },
}, null, 2)}\n`;
const PLUGIN = `{
  "name": "acme",
  "version": "1.2.3",
  "author": { "name": "Someone" }
}
`;
const MARKETPLACE = `{
  "name": "acme-market",
  "plugins": [
    {
      "name": "acme",
      "description": "the plugin",
      "version": "1.2.3",
      "source": "./",
      "author": {
        "name": "Someone"
      }
    },
    {
      "name": "acme-side",
      "version": "0.5.0",
      "source": "./plugins/side"
    }
  ]
}
`;
const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

### Added

- A new thing (L7).

## [1.2.3] - 2026-10-01

### Fixed

- Old fix.
`;
const WHATS_NEW = `# What's new

## In two lines

- **1.2.3**: the old release.

## Version by version

Intro of the long form.

**1.2.3**: the old release, in a long paragraph.
`;

interface Opts { whatsNew?: string | null; plugin?: boolean; lock?: string; changelog?: string }

function project(o: Opts = {}): string {
  const dir = gitRepo();
  const put = (file: string, text: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  put('package.json', PACKAGE);
  put('package-lock.json', o.lock ?? LOCK);
  put('CHANGELOG.md', o.changelog ?? CHANGELOG);
  if (o.plugin !== false) {
    put('.claude-plugin/plugin.json', PLUGIN);
    put('.claude-plugin/marketplace.json', MARKETPLACE);
  }
  if (o.whatsNew !== null) put('docs/whats-new.md', o.whatsNew ?? WHATS_NEW);
  execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: initial');
  return dir;
}

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
const json = (dir: string, file: string) => JSON.parse(read(dir, file));

function release(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['release', ...argv], {
    cwd: dir,
    env: { RAF_TODAY: '2026-10-26' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-10-26T09:00:00'),
  }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** whats-new.md avec les deux formes de la version 1.2.4, à leur place. */
const WHATS_NEW_DONE = `# What's new

## In two lines

- **1.2.4**: a short line.
- **1.2.3**: the old release.

## Version by version

Intro of the long form.

**1.2.4**: the long paragraph.

**1.2.3**: the old release, in a long paragraph.
`;

describe('cadence release — les versions', () => {
  it('R1 — patch, minor et major calculent la version suivante de package.json', () => {
    for (const [kind, next] of [['patch', '1.2.4'], ['minor', '1.3.0'], ['major', '2.0.0']] as const) {
      const dir = project();
      expect(release(dir, kind).code, kind).toBe(1); // whats-new manque, les fichiers sont écrits
      expect(json(dir, 'package.json').version).toBe(next);
    }
  });

  it('R1 — la version est écrite dans package.json, package-lock.json (racine et packages[""]), plugin.json et le plugin du marketplace qui porte son nom', () => {
    const dir = project();
    release(dir, 'patch');
    expect(json(dir, 'package.json').version).toBe('1.2.4');
    const lock = json(dir, 'package-lock.json');
    expect(lock.version).toBe('1.2.4');
    expect(lock.packages[''].version).toBe('1.2.4');
    expect(lock.packages['node_modules/yaml'].version).toBe('2.5.0');
    expect(json(dir, '.claude-plugin/plugin.json').version).toBe('1.2.4');
    const market = json(dir, '.claude-plugin/marketplace.json');
    expect(market.plugins[0].version).toBe('1.2.4');
    expect(market.plugins[1].version).toBe('0.5.0');
  });

  it('R1 — seuls les champs de version changent : le reste des fichiers reste identique à l’octet près', () => {
    const dir = project();
    release(dir, 'minor');
    expect(read(dir, 'package.json')).toBe(PACKAGE.replace('1.2.3', '1.3.0'));
    expect(read(dir, '.claude-plugin/plugin.json')).toBe(PLUGIN.replace('1.2.3', '1.3.0'));
    expect(read(dir, '.claude-plugin/marketplace.json')).toBe(MARKETPLACE.replace('"version": "1.2.3"', '"version": "1.3.0"'));
    const lock = LOCK.replace('"version": "1.2.3"', '"version": "1.3.0"').replace('"version": "1.2.3"', '"version": "1.3.0"');
    expect(read(dir, 'package-lock.json')).toBe(lock);
  });

  it('R2 — une dépendance qui bougerait (lock en retard sur package.json) est refusée, rien n’est écrit', () => {
    const drift = LOCK.replace('"yaml": "^2.5.0"', '"yaml": "^2.4.0"');
    const dir = project({ lock: drift });
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/package-lock\.json/);
    expect(r.err).toMatch(/yaml/);
    expect(read(dir, 'package.json')).toBe(PACKAGE);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('R2 — un package-lock.json dont la version n’est pas celle de package.json est refusé', () => {
    const dir = project({ lock: LOCK.replace('"version": "1.2.3"', '"version": "1.0.0"') });
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/package-lock\.json/);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('R12 — un genre inconnu ou absent, ou une version qui n’est pas x.y.z, donne le usage / un refus', () => {
    const dir = project();
    expect(release(dir).err).toMatch(/usage : cadence release patch\|minor\|major/);
    expect(release(dir, 'huge').code).toBe(2);
    const pre = project();
    writeFileSync(join(pre, 'package.json'), PACKAGE.replace('1.2.3', '1.2.3-beta.1'));
    execFileSync('git', ['commit', '-qam', 'wip'], { cwd: pre });
    const r = release(pre, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/1\.2\.3-beta\.1/);
  });
});

describe('cadence release — le CHANGELOG', () => {
  it('R3 — [Unreleased] devient [x.y.z] - date, avec une section [Unreleased] vide gardée au-dessus', () => {
    const dir = project();
    release(dir, 'patch');
    const text = read(dir, 'CHANGELOG.md');
    expect(text).toContain('## [Unreleased]\n\n## [1.2.4] - 2026-10-26\n\n### Added\n\n- A new thing (L7).\n\n## [1.2.3] - 2026-10-01');
    expect(text.match(/^## \[Unreleased\]/gm)).toHaveLength(1);
  });

  it('R4 — un [Unreleased] vide est refusé (titres de sous-section sans entrée compris)', () => {
    for (const changelog of [CHANGELOG.replace(/### Added\n\n- A new thing \(L7\)\.\n\n/, ''), CHANGELOG.replace('- A new thing (L7).', '')]) {
      const dir = project({ changelog });
      const r = release(dir, 'patch');
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/\[Unreleased\] est vide/);
      expect(git(dir, 'status', '--porcelain')).toBe('');
    }
  });

  it('R4 — un CHANGELOG sans section [Unreleased] est refusé', () => {
    const dir = project({ changelog: CHANGELOG.replace('## [Unreleased]', '## [Next]') });
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/\[Unreleased\]/);
  });

  it('R4 — un dépôt sans CHANGELOG.md est refusé en le disant (code 2, pas de trace de pile), rien n’est écrit', () => {
    const dir = project();
    git(dir, 'rm', '-q', 'CHANGELOG.md');
    commit(dir, 'chore: no changelog');
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/CHANGELOG\.md/);
    expect(json(dir, 'package.json').version).toBe('1.2.3');
  });

  it('R4 — un [Unreleased] vide ne tombe pas sur l’entrée de la version précédente', () => {
    const dir = project({ changelog: CHANGELOG.replace(/### Added\n\n- A new thing \(L7\)\.\n\n/, '') });
    expect(release(dir, 'patch').code).toBe(2);
    expect(read(dir, 'CHANGELOG.md')).not.toContain('[1.2.4]');
  });
});

describe('cadence release — les refus', () => {
  it('R5 — un arbre sale (fichier suivi modifié) est refusé et rien n’est écrit', () => {
    const dir = project();
    writeFileSync(join(dir, 'CHANGELOG.md'), `${CHANGELOG}\nmore\n`);
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/arbre de travail/);
    expect(json(dir, 'package.json').version).toBe('1.2.3');
  });

  it('R5 — un fichier non suivi ne bloque pas (un commit à chemins explicites ne l’embarque pas)', () => {
    const dir = project();
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(release(dir, 'patch').err).not.toMatch(/arbre de travail/);
    expect(json(dir, 'package.json').version).toBe('1.2.4');
  });

  it('R6 — une version déjà taguée est refusée', () => {
    const dir = project();
    git(dir, 'tag', 'v1.2.4');
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/v1\.2\.4/);
    expect(r.err).toMatch(/déjà/);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});

describe('cadence release — rien n’est publié', () => {
  it('R7 — --dry-run décrit tout et n’écrit rien', () => {
    const dir = project({ whatsNew: null });
    const r = release(dir, 'minor', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('1.2.3 → 1.3.0');
    expect(r.out).toContain('package.json');
    expect(r.out).toContain('CHANGELOG.md');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('R8 — la commande ne commite pas, ne tague pas, ne pousse pas', () => {
    const dir = project();
    const head = git(dir, 'rev-parse', 'HEAD');
    release(dir, 'patch');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'tag', '--list')).toBe('');
  });

  it('R9 — elle imprime les étapes du lead dans l’ordre : commit, porte du projet rejouée sur le commit de version (L380), éval --trust-plugin, tag, push, run publish, npm view, marketplace update, plugin update, /reload-plugins', () => {
    const dir = project({ whatsNew: WHATS_NEW_DONE });
    const r = release(dir, 'patch');
    expect(r.code).toBe(0);
    const order = [
      'git add package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md docs/whats-new.md',
      'git commit',
      'cadence verify --gate --sha HEAD',
      'npm run eval:plugin -- --trust-plugin',
      'git tag v1.2.4',
      'git push origin main v1.2.4',
      'gh run watch',
      `npm view ${NAME} version`,
      'claude plugin marketplace update acme-market',
      'claude plugin update acme@acme-market',
      '/reload-plugins',
    ];
    let at = -1;
    for (const step of order) {
      const i = r.out.indexOf(step);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
  });

  it('R9 — --dry-run imprime les mêmes étapes', () => {
    const dir = project();
    const r = release(dir, 'patch', '--dry-run');
    expect(r.out).toContain('git tag v1.2.4');
    expect(r.out).toContain('npm run eval:plugin -- --trust-plugin');
  });
});

describe('cadence release — docs/whats-new.md', () => {
  it('R10 — les deux formes absentes : la commande dit où les écrire et sort en 1 (les fichiers de version sont écrits)', () => {
    const dir = project();
    const r = release(dir, 'patch');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/docs\/whats-new\.md.*ligne de « In two lines » manquante/);
    expect(r.out).toMatch(/docs\/whats-new\.md.*paragraphe long manquant/);
    expect(r.out).toMatch(/en tête de la liste/);
    expect(r.out).toMatch(/juste après l’introduction/);
    expect(json(dir, 'package.json').version).toBe('1.2.4');
  });

  it('R10 — les deux formes présentes et à leur place : rien à signaler, code 0', () => {
    const dir = project({ whatsNew: WHATS_NEW_DONE });
    const r = release(dir, 'patch');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/docs\/whats-new\.md : les deux formes de 1\.2\.4 sont là/);
  });

  it('R10 — les formes écrites dans whats-new.md AVANT la commande (fichier suivi modifié) ne font pas un arbre sale : elles sont relues', () => {
    const dir = project();
    writeFileSync(join(dir, 'docs/whats-new.md'), WHATS_NEW_DONE);
    expect(git(dir, 'status', '--porcelain')).toContain('docs/whats-new.md');
    const r = release(dir, 'patch');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/docs\/whats-new\.md : les deux formes de 1\.2\.4 sont là/);
    expect(json(dir, 'package.json').version).toBe('1.2.4');
  });

  it('R10 — whats-new.md modifié avec un paragraphe mal placé : relu, signalé, code 1 (pas « arbre sale »)', () => {
    const dir = project();
    const misplaced = WHATS_NEW_DONE.replace(/\*\*1\.2\.4\*\*: the long paragraph\.\n\n(\*\*1\.2\.3\*\*: [^\n]*\n)/, '$1\n**1.2.4**: the long paragraph.\n');
    writeFileSync(join(dir, 'docs/whats-new.md'), misplaced);
    const r = release(dir, 'patch');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/paragraphe long mal placé/);
  });

  it('R10 — un autre fichier suivi modifié reste un arbre sale même si whats-new.md l’est aussi', () => {
    const dir = project();
    writeFileSync(join(dir, 'docs/whats-new.md'), WHATS_NEW_DONE);
    writeFileSync(join(dir, 'CHANGELOG.md'), `${CHANGELOG}\nextra\n`);
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/fichiers suivis modifiés/);
  });

  it('R10 — une ligne de plus de 240 caractères est signalée', () => {
    const long = WHATS_NEW_DONE.replace('a short line.', 'x'.repeat(260));
    const dir = project({ whatsNew: long });
    const r = release(dir, 'patch');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ligne de « In two lines » trop longue/);
  });

  it('R10 — un paragraphe long inséré après une version plus ancienne est signalé comme mal placé', () => {
    const misplaced = WHATS_NEW_DONE.replace(/\*\*1\.2\.4\*\*: the long paragraph\.\n\n(\*\*1\.2\.3\*\*: [^\n]*\n)/, '$1\n**1.2.4**: the long paragraph.\n');
    const dir = project({ whatsNew: misplaced });
    const r = release(dir, 'patch');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/paragraphe long mal placé/);
  });

  it('R10 — la ligne courte insérée sous une version plus ancienne est signalée comme mal placée', () => {
    const misplaced = WHATS_NEW_DONE.replace('- **1.2.4**: a short line.\n- **1.2.3**: the old release.', '- **1.2.3**: the old release.\n- **1.2.4**: a short line.');
    const dir = project({ whatsNew: misplaced });
    const r = release(dir, 'patch');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ligne de « In two lines » mal placée/);
  });

  it('R10 — le paragraphe long placé hors de « Version by version » (sous la ligne courte, avant l’introduction, en tête du fichier) est signalé', () => {
    const para = '**1.2.4**: the long paragraph.\n\n';
    const without = WHATS_NEW_DONE.replace(para, '');
    const variants = {
      'sous la ligne courte': without.replace('- **1.2.3**: the old release.\n', `- **1.2.3**: the old release.\n\n${para}`),
      'avant l’introduction': without.replace('Intro of the long form.\n\n', `${para}Intro of the long form.\n\n`),
      'en tête du fichier': `${para}${without}`,
    };
    for (const [where, text] of Object.entries(variants)) {
      const dir = project({ whatsNew: text });
      const r = release(dir, 'patch');
      expect(r.code, where).toBe(1);
      expect(r.out, where).toMatch(/paragraphe long (manquant|mal placé)/);
      expect(r.out, where).not.toMatch(/les deux formes de 1\.2\.4 sont là/);
    }
  });

  it('R10 — une ligne courte placée dans « Version by version » n’est pas la ligne de « In two lines »', () => {
    const text = WHATS_NEW_DONE.replace('- **1.2.4**: a short line.\n', '').replace('**1.2.4**: the long paragraph.', '- **1.2.4**: a short line.\n\n**1.2.4**: the long paragraph.');
    const r = release(project({ whatsNew: text }), 'patch');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ligne de « In two lines » manquante/);
  });

  it('R10 — --dry-run relit les formes déjà écrites : bien placées il le dit (0), mal placées ou absentes il sort en 1 sans rien écrire', () => {
    const ok = project({ whatsNew: WHATS_NEW_DONE });
    const good = release(ok, 'patch', '--dry-run');
    expect(good.code).toBe(0);
    expect(good.out).toMatch(/les deux formes de 1\.2\.4 sont là/);

    const misplaced = WHATS_NEW_DONE.replace('**1.2.4**: the long paragraph.\n\n', '').replace('\n## Version by version', '\n**1.2.4**: the long paragraph.\n\n## Version by version');
    const dir = project({ whatsNew: misplaced });
    const bad = release(dir, 'patch', '--dry-run');
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/paragraphe long/);
    expect(json(dir, 'package.json').version).toBe('1.2.3');

    const none = release(project(), 'patch', '--dry-run');
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/ligne de « In two lines » manquante/);
  });
});

describe('cadence release — mises en forme et dépôts atypiques', () => {
  const reindent = (text: string, unit: string) => JSON.stringify(JSON.parse(text), null, unit) + '\n';
  it('R12 — un package.json, un lock et un plugin.json indentés par tabulations ou 4 espaces sont mis à jour', () => {
    for (const unit of ['\t', '    ']) {
      const dir = project();
      for (const f of ['package.json', 'package-lock.json', '.claude-plugin/plugin.json']) writeFileSync(join(dir, f), reindent(read(dir, f), unit));
      git(dir, 'commit', '-qam', 'chore: indent');
      const r = release(dir, 'patch');
      expect(r.err, JSON.stringify(unit)).toBe('');
      expect(json(dir, 'package.json').version).toBe('1.2.4');
      expect(json(dir, 'package-lock.json').version).toBe('1.2.4');
      expect(json(dir, 'package-lock.json').packages[''].version).toBe('1.2.4');
      expect(json(dir, '.claude-plugin/plugin.json').version).toBe('1.2.4');
    }
  });

  it('R12 — un plugin du marketplace dont source est un objet placé avant version est mis à jour, les autres gardent leur version', () => {
    const dir = project();
    const market = JSON.parse(read(dir, '.claude-plugin/marketplace.json'));
    market.plugins[0] = { name: 'acme', source: { source: 'github', repo: 'acme/acme' }, version: '1.2.3' };
    writeFileSync(join(dir, '.claude-plugin/marketplace.json'), JSON.stringify(market, null, 2) + '\n');
    git(dir, 'commit', '-qam', 'chore: source objet');
    const r = release(dir, 'patch');
    expect(r.err).toBe('');
    const after = json(dir, '.claude-plugin/marketplace.json');
    expect(after.plugins[0].version).toBe('1.2.4');
    expect(after.plugins[1].version).toBe('0.5.0');
  });

  it('R12 — hors dépôt git, la commande refuse (code 2) au lieu d’une trace de pile, sans rien écrire', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), PACKAGE);
    writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG);
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/release : /);
    expect(json(dir, 'package.json').version).toBe('1.2.3');
  });

  it('R9 — sans script eval:plugin, pas d’étape d’éval ; un paquet private n’a pas d’étape npm view', () => {
    const pkg = JSON.parse(PACKAGE);
    delete pkg.scripts;
    pkg.private = true;
    const dir = project({ lock: LOCK });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    git(dir, 'commit', '-qam', 'chore: private');
    const r = release(dir, 'patch');
    expect(r.out).toContain('git tag v1.2.4');
    expect(r.out.indexOf('cadence verify --gate --sha HEAD'), 'la porte reste avant le tag sans étape d’éval').toBeGreaterThan(r.out.indexOf('git commit'));
    expect(r.out.indexOf('cadence verify --gate --sha HEAD')).toBeLessThan(r.out.indexOf('git tag v1.2.4'));
    expect(r.out).not.toMatch(/eval:plugin/);
    expect(r.out).not.toMatch(/npm view/);
  });
});

describe('cadence release — générique', () => {
  it('R11 — sans plugin ni whats-new, seuls package.json, le lock et le CHANGELOG sont versionnés ; pas d’étape de plugin', () => {
    const dir = project({ plugin: false, whatsNew: null });
    const r = release(dir, 'patch');
    expect(r.code).toBe(0);
    expect(json(dir, 'package.json').version).toBe('1.2.4');
    expect(r.out).not.toMatch(/claude plugin/);
    expect(r.out).not.toMatch(/whats-new/);
    expect(r.out).toContain('git add package.json package-lock.json CHANGELOG.md');
  });

  it('R11 — sans package-lock.json, la version se pose quand même', () => {
    const dir = project({ plugin: false, whatsNew: null });
    execFileSync('git', ['rm', '-q', 'package-lock.json'], { cwd: dir });
    commit(dir, 'chore: sans lock');
    expect(release(dir, 'patch').code).toBe(0);
    expect(json(dir, 'package.json').version).toBe('1.2.4');
  });

  it('R11 — dans un dépôt sans package.json, la commande refuse en le disant', () => {
    const dir = gitRepo();
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/package\.json/);
  });
});

describe('cadence release — le plugin du marketplace', () => {
  const side = (dir: string) => json(dir, '.claude-plugin/marketplace.json').plugins;

  it('R13 — le plugin du marketplace est celui qui porte le nom de plugin.json ; les autres gardent leur version', () => {
    const dir = project();
    release(dir, 'patch');
    expect(side(dir).map((p: { name: string; version: string }) => [p.name, p.version])).toEqual([['acme', '1.2.4'], ['acme-side', '0.5.0']]);
  });

  it('R13 — sans plugin.json, le plugin du marketplace est celui qui était à la version du paquet', () => {
    const dir = project();
    execFileSync('git', ['rm', '-q', '.claude-plugin/plugin.json'], { cwd: dir });
    commit(dir, 'chore: sans plugin.json');
    release(dir, 'patch');
    expect(side(dir).map((p: { name: string; version: string }) => [p.name, p.version])).toEqual([['acme', '1.2.4'], ['acme-side', '0.5.0']]);
  });

  it('R13 — un nom de plugin.json absent du marketplace se replie sur le plugin à la version du paquet', () => {
    const dir = project();
    writeFileSync(join(dir, '.claude-plugin/plugin.json'), PLUGIN.replace('"acme"', '"renamed"'));
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: plugin renommé');
    release(dir, 'patch');
    expect(side(dir).map((p: { name: string; version: string }) => [p.name, p.version])).toEqual([['acme', '1.2.4'], ['acme-side', '0.5.0']]);
  });

  it('R13 — aucun plugin ne porte le nom ni la version : refus qui le dit, rien n’est écrit', () => {
    const dir = project();
    writeFileSync(join(dir, '.claude-plugin/plugin.json'), PLUGIN.replace('"acme"', '"renamed"'));
    writeFileSync(join(dir, '.claude-plugin/marketplace.json'), MARKETPLACE.replace('"version": "1.2.3"', '"version": "1.0.0"'));
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: marketplace décalé');
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/n'a pas de plugin « renamed »/);
    expect(json(dir, 'package.json').version).toBe('1.2.3');
  });

  it('R13 — sans plugin.json et sans plugin à la version du paquet : refus « à la version »', () => {
    const dir = project();
    execFileSync('git', ['rm', '-q', '.claude-plugin/plugin.json'], { cwd: dir });
    writeFileSync(join(dir, '.claude-plugin/marketplace.json'), MARKETPLACE.replace('"version": "1.2.3"', '"version": "1.0.0"'));
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: marketplace décalé');
    const r = release(dir, 'patch');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/à la version 1\.2\.3/);
  });
});
