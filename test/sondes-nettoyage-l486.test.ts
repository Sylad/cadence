import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ollamaClassifier, ollamaSousClassifier } from '../src/corrections.js';
import { buildArgs, buildRetryArgs, FORMAT_RETRY_PROMPT, type StepSpec } from '../src/orchestrate/launch.js';
import { activeLock } from '../src/orchestrate/lock.js';
import { effortKey, stepAgent } from '../src/orchestrate/schemas.js';
import { readLock } from '../src/state.js';

const dir = mkdtempSync(join(tmpdir(), 'l486-sonde-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const spec: StepSpec = { kind: 'fix', sessionId: 'sid-1', brief: 'BRIEF', model: 'opus', schema: { type: 'object' }, agent: 'doc-keeper', cwd: '/x', wave: 'w', permissionMode: 'acceptEdits', addDirs: ['/a', '/b'], timeoutMs: 0 };
const agents = { 'doc-keeper': { description: 'd', prompt: 'p' } };

describe('L486 D2 — corps unique buildArgs / buildRetryArgs', () => {
  it('agent absent du paquet : même erreur pour la session et la relance', () => {
    expect(() => buildArgs(spec, {})).toThrow('agent introuvable dans le paquet : doc-keeper');
    expect(() => buildRetryArgs(spec, 's', {})).toThrow('agent introuvable dans le paquet : doc-keeper');
  });
  it('la relance ne diffère de la session que par prompt et --resume au lieu de --session-id', () => {
    const a = buildArgs(spec, agents);
    const r = buildRetryArgs(spec, 'sid-2', agents);
    expect(a[1]).toBe('BRIEF');
    expect(r[1]).toBe(FORMAT_RETRY_PROMPT);
    expect(a.length).toBe(r.length);
    const swap = a.map((x, i) => (i === 1 ? FORMAT_RETRY_PROMPT : x === '--session-id' ? '--resume' : x === 'sid-1' ? 'sid-2' : x));
    expect(r).toEqual(swap);
    expect(r).not.toContain('--session-id');
    expect(a).not.toContain('--resume');
  });
  it('brief vide et addDirs vide : arguments valides, --disallowedTools en dernier sans mcp', () => {
    const a = buildArgs({ ...spec, brief: '', addDirs: [], agent: undefined }, {});
    expect(a[1]).toBe('');
    expect(a).not.toContain('--add-dir');
    expect(a).not.toContain('--agent');
    expect(a).toContain('--disallowedTools');
    expect(a).not.toContain('--mcp-config');
  });
  it('mcpConfig vide (chaîne) : pas de drapeau MCP ; --mcp-config toujours après --disallowedTools', () => {
    expect(buildArgs({ ...spec, mcpConfig: '' }, agents)).not.toContain('--strict-mcp-config');
    const a = buildRetryArgs({ ...spec, mcpConfig: '/m.json' }, 's', agents);
    expect(a.indexOf('--mcp-config')).toBeGreaterThan(a.indexOf('--disallowedTools'));
    expect(a[a.length - 1]).toBe('/m.json');
  });
  it('deux appels de suite donnent le même résultat (pas d’état partagé)', () => {
    expect(buildArgs(spec, agents)).toEqual(buildArgs(spec, agents));
    expect(buildRetryArgs(spec, 's', agents)).toEqual(buildRetryArgs(spec, 's', agents));
  });
});

describe('L486 D4 — stepAgent / effortKey sur tous les genres', () => {
  const kinds = ['implement', 'fix', 'review', 'ux', 'review-small', 'precheck', 'spec', 'accept', 'maquette', 'fiche', 'probe'] as const;
  it('docsFix ne change que fix', () => {
    for (const k of kinds) {
      if (k === 'fix') continue;
      expect(stepAgent(k, true)).toBe(stepAgent(k, false));
    }
    expect(stepAgent('fix', true)).toBe('doc-keeper');
  });
  it('agents attendus par genre (table d’avant le lot)', () => {
    expect(Object.fromEntries(kinds.map((k) => [k, stepAgent(k)]))).toEqual({
      implement: undefined, fix: undefined, review: 'code-reviewer', ux: 'ux-reviewer', 'review-small': 'code-reviewer', precheck: 'precheck-reader', spec: 'spec-writer', accept: 'acceptance-writer', maquette: 'ux-reviewer', fiche: 'code-reviewer', probe: undefined,
    });
  });
  it('effortKey : identité sauf review-small', () => {
    for (const k of kinds) expect(effortKey(k)).toBe(k === 'review-small' ? 'review' : k);
  });
  it('docsFix à undefined explicite ou valeur non booléenne', () => {
    expect(stepAgent('fix', undefined)).toBeUndefined();
    expect(stepAgent('fix', 0 as unknown as boolean)).toBeUndefined();
  });
});

describe('L486 D3 — lecture de verrou, forme réelle', () => {
  const ecrire = (nom: string, texte: string, ageS = 0) => {
    const d = join(dir, nom);
    mkdirSync(d, { recursive: true });
    const f = join(d, 'deliver.lock');
    writeFileSync(f, texte);
    if (ageS) { const t = new Date(Date.now() - ageS * 1000); utimesSync(f, t, t); }
    return d;
  };
  it('verrou de livraison : champs convertis, âge mesuré', () => {
    const l = readLock(ecrire('a', '{"pid":12,"sha":"abc","started":"2026-01-01"}', 30));
    expect(l).toMatchObject({ pid: 12, sha: 'abc', started: '2026-01-01' });
    expect(l!.ageMs).toBeGreaterThan(29_000);
    expect(l!.unreadable).toBeUndefined();
  });
  it('verrou de livraison : vide, tableau, nombre, chaîne JSON, null', () => {
    expect(readLock(ecrire('b', ''))).toMatchObject({ pid: 0, sha: '?', unreadable: true });
    expect(readLock(ecrire('c', 'null'))).toMatchObject({ pid: 0, sha: '?', started: '?', unreadable: true });
    expect(readLock(ecrire('d', '[]'))).toMatchObject({ pid: NaN, sha: 'undefined' });
    expect(readLock(ecrire('e', '42'))?.unreadable).toBeUndefined();
  });
  it('verrou de livraison : dossier absent -> null', () => {
    expect(readLock(join(dir, 'inexistant'))).toBeNull();
  });
  it('verrou d’orchestration : illisible et récent -> actif ; illisible et vieux -> pas actif', () => {
    const f1 = join(dir, 'o1.lock'); writeFileSync(f1, '{trunc');
    expect(activeLock(f1)).not.toBeNull();
    const f2 = join(dir, 'o2.lock'); writeFileSync(f2, '{trunc');
    const t = new Date(Date.now() - 60_000); utimesSync(f2, t, t);
    expect(activeLock(f2)).toBeNull();
  });
  it('verrou d’orchestration : absent -> null ; champs facultatifs absents restent absents', () => {
    expect(activeLock(join(dir, 'rien.lock'))).toBeNull();
    const f = join(dir, 'o3.lock');
    writeFileSync(f, JSON.stringify({ pid: process.pid, wave: 'w', started: 's' }));
    const l = activeLock(f);
    expect(l).not.toBeNull();
    expect(l!.until).toBeUndefined();
    expect('start' in l! ? l!.start : undefined).toBeUndefined();
  });
  it('verrou d’orchestration : until présent mais null dans le JSON', () => {
    const f = join(dir, 'o4.lock');
    writeFileSync(f, JSON.stringify({ pid: 1, wave: 'w', started: 's', until: null }));
    const l = activeLock(f);
    // optional(null) = 'null' : comportement d'avant le lot conservé
    expect(l === null || l.until === 'null').toBe(true);
  });
});

describe('L486 D1 — Ollama commun', () => {
  const pass = { project: 'p', lot: 'L1', findings: ['f'], commits: [] } as never;
  const mk = (rep: (url: string, init: RequestInit) => Promise<Response>) => rep as unknown as typeof fetch;
  it('classeur et sous-classeur : réponse non ok, exception réseau, JSON invalide -> null sans lever', async () => {
    const cas = [
      mk(async () => new Response('x', { status: 500 })),
      mk(async () => { throw new Error('réseau'); }),
      mk(async () => new Response('pas json', { status: 200 })),
    ];
    for (const fetch of cas) {
      expect(await ollamaClassifier({ url: 'http://h', model: 'm', fetch })(pass)).toBeNull();
      expect(await ollamaSousClassifier({ url: 'http://h', model: 'm', fetch })(pass)).toBeNull();
    }
  });
  it('message absent ou contenu vide : null (rien à lire)', async () => {
    const f = mk(async () => new Response('{}', { status: 200 }));
    expect(await ollamaClassifier({ url: 'http://h', model: 'm', fetch: f })(pass)).toBeNull();
    expect(await ollamaSousClassifier({ url: 'http://h', model: 'm', fetch: f })(pass)).toBeNull();
  });
  it('URL avec barre finale, corps envoyé : modèle, stream false, température 0, format avec enum', async () => {
    const vus: { url: string; body: any }[] = [];
    const f = mk(async (url, init) => { vus.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ message: { content: '{"cause":"x","raison":"r"}' } })); });
    await ollamaClassifier({ url: 'http://h:1/', model: 'mm', fetch: f })(pass);
    await ollamaSousClassifier({ url: 'http://h:1', model: 'mm', fetch: f })(pass);
    expect(vus.map((v) => v.url)).toEqual(['http://h:1/api/chat', 'http://h:1/api/chat']);
    for (const v of vus) {
      expect(v.body).toMatchObject({ model: 'mm', stream: false, options: { temperature: 0 } });
      expect(v.body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    }
    expect(Object.keys(vus[0].body.format.properties)).toEqual(['cause', 'raison']);
    expect(Object.keys(vus[1].body.format.properties)).toEqual(['sous', 'raison']);
  });
  it('constats vides : le classeur envoie « (aucun constat lisible) », sans commits « (aucun) »', async () => {
    let user = '';
    const f = mk(async (_u, init) => { user = JSON.parse(String(init.body)).messages[1].content; return new Response('{}'); });
    await ollamaClassifier({ url: 'http://h', model: 'm', fetch: f })({ project: 'p', lot: 'L', findings: [], commits: [] } as never);
    expect(user).toContain('(aucun constat lisible)');
    expect(user).toContain('(aucun)');
  });
});
