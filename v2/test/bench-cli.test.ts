import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { passage } from '../src/bench/cli.js';

const meca = { suite_ok: true, caches_passes: 1, caches_total: 1, mutations_tuees: 1, mutations_total: 1, attendu: 'oui', mutations: [] };
function racine(): string {
  const r = mkdtempSync(join(tmpdir(), 'bench-'));
  for (const id of ['1-a', '2-b']) {
    mkdirSync(join(r, 'bancs', id), { recursive: true }); mkdirSync(join(r, 'secrets', id), { recursive: true });
    writeFileSync(join(r, 'bancs', id, 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: fonction\n');
    writeFileSync(join(r, 'bancs', id, 'demande.md'), 'd'); writeFileSync(join(r, 'secrets', id, 'mesure.md'), 'm');
  }
  const brief = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${brief}\nC:\n  modele: opus\n  brief: ${brief}\n`);
  return r;
}
/** Faux claude : un bras répond tout de suite ; un juge écrit un JSON valide dans le fichier demandé. */
const exec: Executeur = (args) => {
  const p = args[args.indexOf('-p') + 1];
  const m = /dans (\S+\.json)/.exec(p);
  if (m) writeFileSync(m[1], JSON.stringify(m[1].endsWith('meca.json') ? { X: meca, Y: meca }
    : { X: { bloquants: 0, majeurs: 0, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 0 }, prefere: 'egal', ui: 'na', raisons: '' }));
  return { stdout: JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} }), code: 0 };
};
const prep = (_b: unknown, cible: string) => {
  mkdirSync(cible, { recursive: true });
  execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: cible });
  return { testsBase: 0 };
};

describe('passage du banc', () => {
  it('joue les bras un banc après l\'autre, ordre alterné, et écrit rapport et historique', () => {
    const r = racine(); const ordre: string[] = [];
    const exec2: Executeur = (args, o) => { if (!args.includes('--resume') && !/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) ordre.push(o.cwd.split('/').slice(-2).join('/')); return exec(args, o); };
    const v = passage({ racine: r, ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: exec2, prep: prep as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(v.vert).toBe(true);
    expect(ordre).toEqual(['1-a/c1', '1-a/c2', '2-b/c1', '2-b/c2']);
    const map = (id: string) => JSON.parse(readFileSync(join(r, 'runs', '2026-11-08-e1', id, 'resultat.json'), 'utf8')).clones;
    expect(map('1-a')).toEqual({ c1: 'A', c2: 'C' });
    expect(map('2-b')).toEqual({ c1: 'C', c2: 'A' });
    expect(readdirSync(join(r, 'rapports')).sort()).toEqual(['2026-11-08-e1.json', '2026-11-08-e1.md']);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim())).toMatchObject({ empreinte: 'e1', vert: true, hebdo: false });
  });

  it('R11 : un bras en échec saute les juges du banc, verdict rouge', () => {
    const r = racine(); let juges = 0;
    const exec2: Executeur = (args, o) => {
      const p = args[args.indexOf('-p') + 1];
      if (/dans \S+\.json/.test(p)) { juges++; return exec(args, o); }
      if (o.cwd.endsWith('1-a/c1')) return { stdout: JSON.stringify({ session_id: 's', is_error: true, modelUsage: {} }), code: 0 };
      return exec(args, o);
    };
    const v = passage({ racine: r, numeros: ['1'], ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: exec2, prep: prep as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(juges).toBe(0);
    expect(v.vert).toBe(false);
  });

  it('R12 : une préparation qui échoue n\'arrête pas les autres bancs', () => {
    const r = racine(); const cwds: string[] = [];
    const prep2 = (b: { id: string }, cible: string) => { if (b.id === '1-a') throw new Error('futur visible'); return prep(b, cible); };
    const exec2: Executeur = (args, o) => { if (!/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) cwds.push(o.cwd); return exec(args, o); };
    const v = passage({ racine: r, ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: exec2, prep: prep2 as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(cwds.length).toBe(2);
    expect(cwds.every((c) => c.includes('2-b'))).toBe(true);
    expect(v.vert).toBe(false);
    const res = JSON.parse(readFileSync(join(r, 'runs', '2026-11-08-e1', '1-a', 'resultat.json'), 'utf8'));
    expect(res.mesures.A.echec).toContain('préparation : futur visible');
  });
});
