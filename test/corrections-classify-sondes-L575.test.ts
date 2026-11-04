// Sondes des bords de L575 (issue #35) : cadence corrections --classify sans Ollama joignable ou à réponse partielle.
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { FailureTally, unclassifiedLine } from '../src/corrections-echecs.js';
import { tempDir } from './helpers.js';

function lot(runs: string, wave: string, project: string, id: string, constats: string[]) {
  const dir = join(runs, wave);
  mkdirSync(join(dir, `${project}--${id}`), { recursive: true });
  const structured = { bloquants: 0, majeurs: constats.length, mineurs: 0, constats: constats.map((texte) => ({ gravite: 'majeur', fichier: 'src/a.ts', ligne: 1, texte })) };
  writeFileSync(join(dir, `${project}--${id}`, '2-review.json'), JSON.stringify({ structured }));
  const steps = [
    { n: 1, kind: 'implement', status: 'ok', ended: '2026-10-10T08:00:00.000Z', report: '1-implement.json', commits: [] },
    { n: 2, kind: 'review', status: 'ok', ended: '2026-10-10T08:00:00.000Z', report: '2-review.json', commits: [] },
    { n: 3, kind: 'fix', status: 'ok', ended: '2026-10-10T08:00:00.000Z', report: '3-fix.json', commits: [`abc3 fix(${id}): correctif`] },
  ];
  writeFileSync(join(dir, `${project}--${id}.json`), JSON.stringify({ project, lot: id, visible: false, status: 'ready', steps }));
  writeFileSync(join(dir, 'wave.json'), '{}');
}
function parentWithRuns(n = 3) {
  const parent = tempDir();
  const runs = join(parent, '.cadence', 'runs');
  mkdirSync(runs, { recursive: true });
  for (let i = 1; i <= n; i++) lot(runs, 'w1', 'alpha', `L${i}`, [`constat ${i}`]);
  return parent;
}
async function cad(dir: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-10', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-10T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
async function serve(answer: (n: number) => { status: number; body: string }) {
  let n = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const a = answer(n++);
      res.statusCode = a.status;
      res.setHeader('content-type', 'application/json');
      res.end(a.body);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
const chat = (content: string) => ({ status: 200, body: JSON.stringify({ message: { content } }) });

describe('L575 — bilan des passes non classées', () => {
  it('unclassifiedLine : singulier pour une passe, « raison inconnue » sans raison', () => {
    expect(unclassifiedLine('classement', 1, 1, new FailureTally())).toBe('classement : 1 passe non classée sur 1 (raison inconnue)');
  });

  it('FailureTally : ordre stable à égalité, tri par effectif décroissant', () => {
    const t = new FailureTally();
    t.add('b'); t.add('a'); t.add('c'); t.add('c');
    expect(t.render()).toBe('c ×2, a ×1, b ×1');
  });
});

describe('L575 — bords de --classify', () => {
  it('réponse 200 au corps non JSON : Ollama est joignable, il ne doit pas être dit « injoignable »', async () => {
    const srv = await serve(() => ({ status: 200, body: '<html>proxy</html>' }));
    try {
      const parent = parentWithRuns();
      const r = await cad(parent, { OLLAMA_HOST: srv.host }, 'corrections', parent, '--classify');
      expect(r.code).toBe(1);
      expect(r.err).not.toContain('injoignable');
    } finally {
      srv.close();
    }
  });

  it('OLLAMA_HOST vide : une ligne, code 1, aucun fichier écrit', async () => {
    const parent = parentWithRuns();
    const r = await cad(parent, { OLLAMA_HOST: '' }, 'corrections', parent, '--classify');
    expect(r.code).toBe(1);
    expect(r.err).toContain("rien n'est classé");
    expect(existsSync(join(parent, '.cadence', 'corrections.json'))).toBe(false);
  });

  it('OLLAMA_HOST avec barre finale : le message nomme l\'hôte tel que donné, une seule ligne d\'échec', async () => {
    const parent = parentWithRuns();
    const r = await cad(parent, { OLLAMA_HOST: 'http://127.0.0.1:1/' }, 'corrections', parent, '--classify');
    expect(r.code).toBe(1);
    expect(r.err.split('\n').filter((l) => l.includes('injoignable'))).toHaveLength(1);
  });

  it('injoignable avec un cache existant déjà classé et une passe restante : code 1, fichier octet pour octet intact', async () => {
    const parent = parentWithRuns();
    const file = join(parent, '.cadence', 'corrections.json');
    const kept = '{"w1/alpha--L1/3":{"cause":"test-manquant","by":"ollama:m"}}';
    writeFileSync(file, kept);
    const r = await cad(parent, { OLLAMA_HOST: 'http://127.0.0.1:1' }, 'corrections', parent, '--classify');
    expect(r.code).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(kept);
  });

  it('Ollama tombe après une réponse : le bilan nomme « Ollama injoignable », code 0, la classée est écrite', async () => {
    const srv = await serve((n) => (n === 0 ? chat('{"cause":"test-manquant","raison":"r"}') : { status: 200, body: 'x' }));
    const host = srv.host;
    const parent = parentWithRuns();
    // l'hôte tombe après la première réponse : on ferme le serveur dès qu'il a répondu
    const first = cad(parent, { OLLAMA_HOST: host }, 'corrections', parent, '--classify');
    const r = await first;
    srv.close();
    expect(r.err).toMatch(/classement : 2 passes non classées sur 3 \(/);
    expect(Object.keys(JSON.parse(readFileSync(join(parent, '.cadence', 'corrections.json'), 'utf8')))).toHaveLength(1);
  });

  it('sous-causes toutes perdues après des causes bug-code classées : le bilan des sous-causes, et aucun fichier de sous-causes vide créé', async () => {
    const srv = await serve((n) => (n < 3 ? chat('{"cause":"bug-code","raison":"r"}') : { status: 500, body: '{}' }));
    try {
      const parent = parentWithRuns(3);
      const r = await cad(parent, { OLLAMA_HOST: srv.host }, 'corrections', parent, '--classify');
      expect(r.code).toBe(0);
      expect(r.err).toContain('sous-causes : 3 passes non classées sur 3 (réponse HTTP 500 ×3)');
      expect(existsSync(join(parent, '.cadence', 'corrections-sous-causes.json'))).toBe(false);
    } finally {
      srv.close();
    }
  });

  it('deux --classify de suite après un échec total : le second échoue pareil, sans fichier', async () => {
    const parent = parentWithRuns();
    const a = await cad(parent, { OLLAMA_HOST: 'http://127.0.0.1:1' }, 'corrections', parent, '--classify');
    const b = await cad(parent, { OLLAMA_HOST: 'http://127.0.0.1:1' }, 'corrections', parent, '--classify');
    expect([a.code, b.code]).toEqual([1, 1]);
    expect(b.err).toBe(a.err);
    expect(existsSync(join(parent, '.cadence', 'corrections.json'))).toBe(false);
  });

  it('--classify --json en échec : rien sur la sortie standard', async () => {
    const parent = parentWithRuns();
    const r = await cad(parent, { OLLAMA_HOST: 'http://127.0.0.1:1' }, 'corrections', parent, '--classify', '--json');
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
  });

  it('aucune passe avec constats et pas de fichier : code 0, fichier créé vide (comportement d\'avant conservé)', async () => {
    const parent = tempDir();
    mkdirSync(join(parent, '.cadence', 'runs'), { recursive: true });
    const r = await cad(parent, { OLLAMA_HOST: 'http://127.0.0.1:1' }, 'corrections', parent, '--classify');
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('injoignable');
  });
});
