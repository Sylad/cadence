import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
    const dir = mkdtempSync(join(tmpdir(), 'cadence-publish-'));
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
