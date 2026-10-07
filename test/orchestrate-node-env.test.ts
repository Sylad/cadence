import { describe, expect, it } from 'vitest';
import { nvmVersionsDir, resolveNode, type NodeFs } from '../src/orchestrate/node-env.js';

const V = '/nvm/versions/node';
const fsOf = (nvmrc: string | null, installed: string[]): NodeFs => ({
  read: (f) => (f === '/repo/.nvmrc' ? nvmrc : null),
  list: (d) => (d === V ? installed : []),
});
const inst = ['v20.20.2', 'v22.22.2', 'v22.22.3', 'v22.9.0'];

describe('resolveNode (.nvmrc)', () => {
  it('pas de .nvmrc : rien', () => {
    expect(resolveNode('/repo', V, fsOf(null, inst))).toEqual({ kind: 'none' });
  });
  it.each(['22', 'v22', '22\n', ' v22 '])('« %s » : la plus haute 22.x (comparaison numérique, 22.22.3 > 22.9.0)', (rc) => {
    expect(resolveNode('/repo', V, fsOf(rc, inst))).toEqual({ kind: 'ok', version: 'v22.22.3', wanted: rc.trim(), bin: `${V}/v22.22.3/bin` });
  });
  it('22.22 et v22.22.2 : préfixe exact, pas de confusion 22.2 / 22.22', () => {
    expect(resolveNode('/repo', V, fsOf('22.22', inst))).toMatchObject({ kind: 'ok', version: 'v22.22.3' });
    expect(resolveNode('/repo', V, fsOf('v22.22.2', inst))).toMatchObject({ kind: 'ok', version: 'v22.22.2' });
    expect(resolveNode('/repo', V, fsOf('22.2', inst))).toMatchObject({ kind: 'missing' });
  });
  it('version absente : refus qui nomme la version et le dossier', () => {
    const r = resolveNode('/repo', V, fsOf('24', inst));
    expect(r).toMatchObject({ kind: 'missing' });
    if (r.kind === 'missing') expect(r.message).toContain('24');
    if (r.kind === 'missing') expect(r.message).toContain(V);
  });
  it.each(['lts/*', 'node', 'stable', 'lts/iron', ''])('« %s » : non résoluble, pas de repli', (rc) => {
    expect(resolveNode('/repo', V, fsOf(rc, inst))).toMatchObject({ kind: 'missing' });
  });
  it('NVM_DIR ou ~/.nvm', () => {
    expect(nvmVersionsDir({ NVM_DIR: '/x/nvm' }, '/h')).toBe('/x/nvm/versions/node');
    expect(nvmVersionsDir({}, '/h')).toBe('/h/.nvm/versions/node');
  });
});
