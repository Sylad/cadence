import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chercherFuites, fuitesDuBras, dossierTranscripts, reglesDuBras } from '../src/bench/fuites.js';

const H = '/home/u';
const appel = (input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
const r = reglesDuBras(H, `${H}/bench-cadence`, '1-t', `${H}/bench-cadence/runs/r1/1-t/A`);

const outil = (name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

describe('fuites', () => {
  it('lire son clone, les pièces du banc et ses propres sorties : permis', () => {
    const l = [appel({ command: `cat ${H}/bench-cadence/runs/r1/1-t/A/src/x.ts` }),
      appel({ file_path: `${H}/bench-cadence/bancs/1-t/pieces/maquette.png` }),
      appel({ file_path: `${dossierTranscripts(H, `${H}/bench-cadence/runs/r1/1-t/A`)}/s/tool-results/a.txt` })];
    expect(chercherFuites(l, r, H)).toEqual([]);
  });
  it('les secrets du banc, les vrais dépôts, les transcripts et les autres bras : interdits', () => {
    const l = [appel({ command: `cat ~/bench-cadence/secrets/1-t/attendu.md` }),
      appel({ file_path: `${H}/projects/developpeur/ol-companion/src/a.ts` }),
      appel({ command: `grep L239 ${H}/.claude/projects/-x/y.jsonl` }),
      appel({ command: `ls ${H}/bench-cadence/runs/r1/1-t/equipe-legere` })];
    expect(chercherFuites(l, r, H)).toEqual([
      `${H}/bench-cadence/secrets/1-t/attendu.md`, `${H}/projects/developpeur/ol-companion/src/a.ts`,
      `${H}/.claude/projects/-x/y.jsonl`, `${H}/bench-cadence/runs/r1/1-t/equipe-legere`]);
  });
  it('lignes illisibles ou sans outil : ignorées', () => {
    expect(chercherFuites(['pas du json', JSON.stringify({ type: 'user' })], r, H)).toEqual([]);
  });
  it('nom du dossier de transcripts de Claude Code', () => {
    expect(dossierTranscripts('/h', '/h/bench-cadence/runs/r_1/A')).toBe('/h/.claude/projects/-h-bench-cadence-runs-r-1-A');
  });
  const C = `${H}/bench-cadence/runs/r1/1-t/A`;
  const S = `${H}/bench-cadence/secrets/1-t/attendu.md`;
  const avecCwd = (cwd: string, input: object) => JSON.stringify({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
  it('cwd persistant de la ligne : mkdir -p ../../A.captures depuis <clone>/frontend n\'est pas une fuite', () => {
    expect(chercherFuites([avecCwd(`${C}/frontend`, { command: 'mkdir -p ../../A.captures' })], r, H, C)).toEqual([]);
  });
  it('cwd persistant de la ligne : cat ../../../../secrets/... (cinq niveaux) depuis <clone>/frontend est une fuite', () => {
    expect(chercherFuites([avecCwd(`${C}/frontend`, { command: 'cat ../../../../../secrets/1-t/attendu.md' })], r, H, C)).toEqual([S]);
  });
  it('chemins relatifs, « .. », cd, ${HOME} et accolades', () => {
    expect(chercherFuites([appel({ command: 'cat ../../../../secrets/1-t/attendu.md' })], r, H, C)).toEqual([S]);
    expect(chercherFuites([appel({ file_path: `${C}/../A2/x` })], r, H, C)).toEqual([`${H}/bench-cadence/runs/r1/1-t/A2/x`]);
    expect(chercherFuites([appel({ command: 'cd ~/bench-cadence && cat secrets/1-t/attendu.md' })], r, H, C)).toEqual([S]);
    expect(chercherFuites([appel({ command: 'cat ${HOME}/bench-cadence/secrets/1-t/a' })], r, H, C)).toEqual([`${H}/bench-cadence/secrets/1-t/a`]);
    expect(chercherFuites([appel({ command: 'ls ~/bench-cadence/{secrets,x}/f' })], r, H, C)).toEqual([`${H}/bench-cadence/secrets/f`]);
    expect(chercherFuites([appel({ command: 'cd ../../../../secrets' })], r, H, C)).toEqual([`${H}/bench-cadence/secrets`]);
  });
  it('cd dans son clone puis « .. » restant dedans : permis', () => {
    expect(chercherFuites([appel({ command: 'cd frontend && cat ../package.json' })], r, H, C)).toEqual([]);
  });
  it('relatifs dans le contenu des fichiers : ignorés ; absolu ou ~ : fuite', () => {
    expect(chercherFuites([outil('Write', { file_path: `${C}/frontend/src/a/b.ts`, content: "import x from '../../shared/y'" })], r, H, C)).toEqual([]);
    expect(chercherFuites([outil('Edit', { file_path: `${C}/a.ts`, old_string: 'a', new_string: "'../../../util'" })], r, H, C)).toEqual([]);
    expect(chercherFuites([outil('Write', { file_path: `${C}/n.md`, content: 'voir ~/bench-cadence/secrets/1-t/attendu.md' })], r, H, C)).toEqual([S]);
  });
  it('fuitesDuBras lit aussi les transcripts de sous-agents', () => {
    const home = mkdtempSync(join(tmpdir(), 'fu-'));
    const clone = `${home}/bench-cadence/runs/r1/1-t/A`;
    const dir = `${dossierTranscripts(home, clone)}/sess/subagents`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/agent-x.jsonl`, appel({ command: `cat ${home}/bench-cadence/secrets/1-t/a` }) + '\n');
    expect(fuitesDuBras(home, `${home}/bench-cadence`, '1-t', clone)).toEqual([`${home}/bench-cadence/secrets/1-t/a`]);
  });
});
