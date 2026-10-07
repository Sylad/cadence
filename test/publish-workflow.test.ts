import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tempDir } from './helpers.js';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const workflow = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8');

describe('publish.yml', () => {
  it('épingle npm sur la majeure 11 (≥ 11.5.1 pour la publication de confiance)', () => {
    expect(workflow).toContain('npm install -g npm@^11.5.1');
    expect(workflow).not.toContain('npm@latest');
  });

  it('contrôle le tag contre package.json et les deux fichiers du plugin', () => {
    for (const file of ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
      expect(workflow).toContain(file);
    }
  });
});

describe('étape de contrôle du tag', () => {
  const files = ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];
  const read = (f: string) => JSON.parse(readFileSync(join(root, f), 'utf8'));
  const version: string = read('package.json').version;
  const step = workflow.match(/- name: Le tag correspond[^\n]*\n\s+run: \|\n((?:\s{10}.*\n|\n)+)/)?.[1];

  // Exécute le script de l'étape tel quel, dans une copie des trois fichiers de version.
  const runStep = (tag: string, edit?: (dir: string) => void) => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, '.claude-plugin'));
      for (const f of files) cpSync(join(root, f), join(dir, f));
      edit?.(dir);
      return spawnSync('bash', ['-e', '-c', step!], { cwd: dir, env: { ...process.env, GITHUB_REF_NAME: tag }, encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('trouve le script de l\'étape', () => {
    expect(step).toBeTruthy();
  });

  it('passe quand le tag est la version des trois fichiers', () => {
    expect(runStep(`v${version}`).status).toBe(0);
  });

  it('échoue sur un tag faux', () => {
    const r = runStep('v99.99.99');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('tag v99.99.99 ≠ version de package.json');
  });

  it.each(files.slice(1))('échoue quand %s est resté sur une autre version', (file) => {
    const r = runStep(`v${version}`, (dir) => {
      const json = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (json.plugins) json.plugins[0].version = '0.0.0';
      else json.version = '0.0.0';
      writeFileSync(join(dir, file), JSON.stringify(json));
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`≠ version de ${file}`);
  });
});

describe('versions du plugin', () => {
  it('plugin.json et marketplace.json suivent package.json', () => {
    const read = (f: string) => JSON.parse(readFileSync(join(root, f), 'utf8'));
    const version = read('package.json').version;
    expect(read('.claude-plugin/plugin.json').version).toBe(version);
    expect(read('.claude-plugin/marketplace.json').plugins[0].version).toBe(version);
  });
});

describe('notes de version', () => {
  const step = workflow.match(/- name: Le CHANGELOG a une section pour le tag\n\s+run: \|\n((?:\s{10}.*\n|\n)+)/)?.[1];
  const changelog = '# Changelog\n\n## [1.2.0] - 2026-01-02\n\n### Added\n- thing (L1)\n\n## [1.1.0] - 2026-01-01\n\n- older\n';

  // Exécute le script de l'étape tel quel, dans un dossier avec un CHANGELOG donné.
  const runNotes = (tag: string, text: string) => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'CHANGELOG.md'), text);
      const r = spawnSync('bash', ['-e', '-c', step!], { cwd: dir, env: { ...process.env, GITHUB_REF_NAME: tag, RUNNER_TEMP: dir }, encoding: 'utf8' });
      let notes: string | undefined;
      try { notes = readFileSync(join(dir, 'release-notes.md'), 'utf8'); } catch { /* aucune note écrite */ }
      return { ...r, notes };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('trouve le script de l\'étape', () => {
    expect(step).toBeTruthy();
  });

  it('écrit la section du tag, rien des autres', () => {
    const r = runNotes('v1.2.0', changelog);
    expect(r.status).toBe(0);
    expect(r.notes).toContain('thing (L1)');
    expect(r.notes).not.toContain('older');
    expect(r.notes).not.toContain('## [');
  });

  it('prend aussi la dernière section du fichier', () => {
    expect(runNotes('v1.1.0', changelog).notes).toContain('older');
  });

  it('refuse un tag sans section', () => {
    const r = runNotes('v1.3.0', changelog);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('CHANGELOG.md');
  });

  it('refuse une section vide', () => {
    expect(runNotes('v1.2.0', '## [1.2.0] - 2026-01-02\n\n## [1.1.0]\n- x\n').status).toBe(1);
  });

  it('ne prend pas 1.2.0 pour un préfixe de 1.2.01 ou 11.2.0', () => {
    expect(runNotes('v1.2.0', '## [11.2.0]\n- x\n').status).toBe(1);
    expect(runNotes('v1.2.0', '## [1.2.01]\n- x\n').status).toBe(1);
  });

  it('crée la release GitHub avec ces notes, après la publication', () => {
    expect(workflow).toMatch(/contents: write/);
    const publish = workflow.indexOf('npm publish');
    const release = workflow.indexOf('gh release create');
    expect(release).toBeGreaterThan(publish);
    expect(workflow).toContain('--notes-file');
  });

  it('ne laisse pas le jeton en écriture dans .git/config', () => {
    expect(workflow).toMatch(/actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/);
  });

  it('contrôle le CHANGELOG avant toute publication', () => {
    expect(workflow.indexOf('Le CHANGELOG a une section')).toBeLessThan(workflow.indexOf('npm publish'));
  });
});

describe('doublon de run pour un même tag (L64)', () => {
  const step = workflow.match(/- name: La version est-elle déjà au registre\n\s+id: registry\n\s+run: \|\n((?:\s{10}.*\n|\n)+)/)?.[1];

  // Exécute le script de l'étape avec un faux `npm view` : sortie et code donnés.
  const runRegistry = (npmView: { out: string; code: number }) => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh\necho "$@" > "${dir}/npm-args"\necho "${npmView.out}"\nexit ${npmView.code}\n`, { mode: 0o755 });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cadence-x', version: '1.2.3' }));
      writeFileSync(join(dir, 'output'), '');
      const r = spawnSync('bash', ['-e', '-c', step!], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_REF_NAME: 'v1.2.3', GITHUB_OUTPUT: join(dir, 'output') },
        encoding: 'utf8',
      });
      return { ...r, output: readFileSync(join(dir, 'output'), 'utf8'), args: readFileSync(join(dir, 'npm-args'), 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('sérialise les runs d\'un même ref sans annuler celui qui publie', () => {
    expect(workflow).toMatch(/concurrency:\n\s+group: publish-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: false/);
  });

  it('trouve le script de l\'étape', () => {
    expect(step).toBeTruthy();
  });

  it('déjà au registre : sort en succès, dit pourquoi, published=true', () => {
    const r = runRegistry({ out: '1.2.3', code: 0 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1.2.3 est déjà publiée sur npm');
    expect(r.output).toContain('published=true');
    expect(r.args).toContain('cadence-x@1.2.3');
  });

  it('absente du registre (E404) : published=false', () => {
    const r = runRegistry({ out: 'npm error code E404', code: 1 });
    expect(r.status).toBe(0);
    expect(r.output).toContain('published=false');
  });

  it('erreur du registre autre que E404 (5xx, réseau) : échoue, n\'écrit aucun published', () => {
    for (const out of ['npm error code E500', 'npm error code ENOTFOUND']) {
      const r = runRegistry({ out, code: 1 });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(out);
      expect(r.output).toBe('');
    }
  });

  it('npm publish est sauté quand la version est déjà publiée, la release n\'est créée que si absente', () => {
    expect(workflow).toMatch(/if: steps\.registry\.outputs\.published != 'true'\n\s+run: npm publish/);
    expect(workflow).toMatch(/gh release view "\$GITHUB_REF_NAME"[\s\S]*gh release create/);
  });

  it('le contrôle du registre précède npm publish', () => {
    expect(workflow.indexOf('id: registry')).toBeLessThan(workflow.indexOf('npm publish --access'));
  });
});
