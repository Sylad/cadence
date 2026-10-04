import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

describe('versions du plugin', () => {
  it('plugin.json et marketplace.json suivent package.json', () => {
    const read = (f: string) => JSON.parse(readFileSync(join(root, f), 'utf8'));
    const version = read('package.json').version;
    expect(read('.claude-plugin/plugin.json').version).toBe(version);
    expect(read('.claude-plugin/marketplace.json').plugins[0].version).toBe(version);
  });
});
