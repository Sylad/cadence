import { describe, expect, it } from 'vitest';
import { chercherFuites, dossierTranscripts, reglesDuBras } from '../src/bench/fuites.js';

const H = '/home/u';
const appel = (input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
const r = reglesDuBras(H, `${H}/bench-cadence`, '1-t', `${H}/bench-cadence/runs/r1/1-t/A`);

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
});
