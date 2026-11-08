import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lectureReferences } from '../src/sequence/mesures.js';

// Le vrai script du hook, lancé comme Claude Code le lance : JSON sur stdin, refus = code 2 + raison sur stderr + décision JSON sur stdout.
const HOOK = join(import.meta.dirname, '..', 'hooks', 'lecture-obligatoire.mjs');
const outil = (name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

function monde(pieces?: string[]) {
  const r = mkdtempSync(join(tmpdir(), 'hook-lecture-'));
  const clone = join(r, 'run', 'c1'); mkdirSync(join(clone, 'src'), { recursive: true });
  const ref = join(r, 'ref'); mkdirSync(ref);
  const doc = join(ref, 'norme.md'), fig = join(ref, 'fig.png');
  writeFileSync(doc, 'n'); writeFileSync(fig, 'p');
  if (pieces !== undefined) writeFileSync(`${clone}.pieces.json`, JSON.stringify({ etape: 1, pieces }));
  const t = join(r, 'projets', 'sess.jsonl'); mkdirSync(join(r, 'projets'));
  const ecrire = (lignes: string[], f = t) => { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, `${lignes.join('\n')}\n`); };
  return { r, clone, doc, fig, t, ecrire };
}
function hook(entree: object): { code: number; stdout: string; stderr: string } {
  const p = spawnSync('node', [HOOK], { input: JSON.stringify(entree), encoding: 'utf8' });
  return { code: p.status ?? -1, stdout: p.stdout, stderr: p.stderr };
}
const ecriture = (m: ReturnType<typeof monde>, file_path = join(m.clone, 'src', 'a.ts'), tool_name = 'Write') =>
  ({ hook_event_name: 'PreToolUse', tool_name, tool_input: { file_path, content: 'x' }, transcript_path: m.t, cwd: m.clone });
function refuse(r: ReturnType<typeof hook>, piece: string) {
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(piece);
  const d = JSON.parse(r.stdout).hookSpecificOutput;
  expect(d).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  expect(d.permissionDecisionReason).toMatch(/^Lis d'abord en entier/);
}
const permis = (r: ReturnType<typeof hook>) => expect([r.code, r.stdout]).toEqual([0, '']);

describe('hook lecture obligatoire', () => {
  it('pièce non lue : refus qui la nomme', () => {
    const m = monde(); writeFileSync(`${m.clone}.pieces.json`, JSON.stringify({ pieces: [m.doc, m.fig] }));
    m.ecrire([outil('Read', { file_path: m.doc })]);
    const r = hook(ecriture(m));
    refuse(r, m.fig); expect(r.stderr).not.toContain(m.doc);
  });
  it('lue partiellement (offset, limit ou pages) : refus (R30)', () => {
    for (const partiel of [{ limit: 10 }, { offset: 3 }, { pages: '1-2' }]) {
      const m = monde([]); writeFileSync(`${m.clone}.pieces.json`, JSON.stringify({ pieces: [m.doc] }));
      m.ecrire([outil('Read', { file_path: m.doc, ...partiel })]);
      refuse(hook(ecriture(m)), m.doc);
    }
  });
  it('lue en entier : permis ; Edit, MultiEdit, NotebookEdit et chemin relatif suivent la même règle', () => {
    const m = monde(); writeFileSync(`${m.clone}.pieces.json`, JSON.stringify({ pieces: [m.doc] }));
    m.ecrire([outil('Read', { file_path: m.doc, limit: 5 }), outil('Read', { file_path: m.doc })]);
    permis(hook(ecriture(m)));
    permis(hook(ecriture(m, 'src/b.ts', 'Edit')));
    m.ecrire([]);
    refuse(hook(ecriture(m, 'src/b.ts', 'MultiEdit')), m.doc);
    refuse(hook({ tool_name: 'NotebookEdit', tool_input: { notebook_path: join(m.clone, 'n.ipynb') }, transcript_path: m.t, cwd: m.clone }), m.doc);
  });
  it('image lue : permis', () => {
    const m = monde([]); writeFileSync(`${m.clone}.pieces.json`, JSON.stringify({ pieces: [m.fig] }));
    m.ecrire([outil('Read', { file_path: m.fig })]);
    permis(hook(ecriture(m)));
  });
  it('écriture hors du clone (captures, dossier voisin) : permis', () => {
    const m = monde([]); writeFileSync(`${m.clone}.pieces.json`, JSON.stringify({ pieces: [m.doc] }));
    m.ecrire([]);
    permis(hook(ecriture(m, `${m.clone}.captures/a.png`)));
    permis(hook(ecriture(m, join(m.r, 'run', 'c1x', 'a.ts'))));
    permis(hook({ ...ecriture(m), tool_name: 'Bash', tool_input: { command: 'ls' } }));
  });
  it('sans pieces.json, ou liste vide : permis', () => {
    const m = monde(); m.ecrire([]);
    permis(hook(ecriture(m)));
    writeFileSync(`${m.clone}.pieces.json`, JSON.stringify({ pieces: [] }));
    permis(hook(ecriture(m)));
  });
  it('pieces.json illisible : refus qui le dit', () => {
    const m = monde(); m.ecrire([]); writeFileSync(`${m.clone}.pieces.json`, '{');
    const r = hook(ecriture(m));
    expect(r.code).toBe(2); expect(r.stderr).toMatch(/illisible/);
  });
  it('lue par un sous-agent : permis, que le hook reçoive le transcript principal ou celui du sous-agent', () => {
    const m = monde(); writeFileSync(`${m.clone}.pieces.json`, JSON.stringify({ pieces: [m.doc, m.fig] }));
    const sous = join(m.r, 'projets', 'sess', 'subagents', 'agent-1.jsonl');
    m.ecrire([outil('Read', { file_path: m.fig })]);
    m.ecrire([JSON.stringify({ isSidechain: true, ...JSON.parse(outil('Read', { file_path: m.doc })) })], sous);
    permis(hook(ecriture(m)));
    permis(hook({ ...ecriture(m), transcript_path: sous }));
  });
  it('le hook et la mesure lectureReferences partagent la définition de « lire en entier »', () => {
    const m = monde(); writeFileSync(`${m.clone}.pieces.json`, JSON.stringify({ pieces: [m.doc] }));
    const lignes = [outil('Read', { file_path: m.doc, pages: '1' })];
    m.ecrire(lignes);
    expect(lectureReferences(lignes, [m.doc], m.clone).partielles).toEqual([m.doc]);
    refuse(hook(ecriture(m)), m.doc);
  });
  it('rapide : transcript de 20 Mo lu en moins d\'une seconde (pièce lue à la fin)', () => {
    const m = monde(); writeFileSync(`${m.clone}.pieces.json`, JSON.stringify({ pieces: [m.doc] }));
    const fd = openSync(m.t, 'w'), bruit = `${outil('Bash', { command: 'x'.repeat(2000) })}\n${outil('Read', { file_path: join(m.clone, 'src', 'a.ts') })}\n`;
    for (let n = 0; n < 20 << 20; n += bruit.length) writeSync(fd, bruit);
    writeSync(fd, `${outil('Read', { file_path: m.doc })}\n`); closeSync(fd);
    const t0 = performance.now(); const r = hook(ecriture(m)); const ms = performance.now() - t0;
    permis(r);
    expect(ms).toBeLessThan(1000);
  });
});
