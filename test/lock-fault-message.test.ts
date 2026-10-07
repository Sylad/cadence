import { describe, expect, it } from 'vitest';
import { lockFault } from '../src/state.js';

describe('lockFault', () => {
  it('donne le code errno quand il existe', () => {
    expect(lockFault('/x/lock', Object.assign(new Error('boom'), { code: 'EPERM' }))).toBe('verrou /x/lock : EPERM');
  });

  it('se replie sur le message d\'une Error sans code', () => {
    expect(lockFault('/x/lock', new Error('boom'))).toBe('verrou /x/lock : boom');
  });

  it('se replie sur la valeur levée quand ce n\'est pas une Error', () => {
    expect(lockFault('/x/lock', 'boom')).toBe('verrou /x/lock : boom');
    expect(lockFault('/x/lock', undefined)).toBe('verrou /x/lock : undefined');
  });
});
