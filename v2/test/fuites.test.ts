import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chercherFuites, fuitesDuBras, dossierTranscripts, reglesDuBras } from '../src/bench/fuites.js';

const H = '/home/u';
const appel = (input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
const r = reglesDuBras(H, `${H}/bench-cadence`, '1-t', `${H}/bench-cadence/runs/r1/1-t/c1`);

const outil = (name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

describe('fuites', () => {
  it('lire son clone, les pièces du banc et ses propres sorties : permis', () => {
    const l = [appel({ command: `cat ${H}/bench-cadence/runs/r1/1-t/c1/src/x.ts` }),
      appel({ file_path: `${H}/bench-cadence/bancs/1-t/pieces/maquette.png` }),
      appel({ file_path: `${dossierTranscripts(H, `${H}/bench-cadence/runs/r1/1-t/c1`)}/s/tool-results/a.txt` })];
    expect(chercherFuites(l, r, H).certaines).toEqual([]);
  });
  it('les secrets du banc, les vrais dépôts, les transcripts et les autres bras : interdits', () => {
    const l = [appel({ command: `cat ~/bench-cadence/secrets/1-t/attendu.md` }),
      appel({ file_path: `${H}/projects/developpeur/ol-companion/src/a.ts` }),
      appel({ command: `grep L239 ${H}/.claude/projects/-x/y.jsonl` }),
      appel({ command: `ls ${H}/bench-cadence/runs/r1/1-t/c2` })];
    expect(chercherFuites(l, r, H).certaines).toEqual([
      `${H}/bench-cadence/secrets/1-t/attendu.md`, `${H}/projects/developpeur/ol-companion/src/a.ts`,
      `${H}/.claude/projects/-x/y.jsonl`, `${H}/bench-cadence/runs/r1/1-t/c2`]);
  });
  it('lignes illisibles ou sans outil : ignorées', () => {
    expect(chercherFuites(['pas du json', JSON.stringify({ type: 'user' })], r, H).certaines).toEqual([]);
  });
  it('nom du dossier de transcripts de Claude Code', () => {
    expect(dossierTranscripts('/h', '/h/bench-cadence/runs/r_1/c1')).toBe('/h/.claude/projects/-h-bench-cadence-runs-r-1-c1');
  });
  const C = `${H}/bench-cadence/runs/r1/1-t/c1`;
  const S = `${H}/bench-cadence/secrets/1-t/attendu.md`;
  const avecCwd = (cwd: string, input: object) => JSON.stringify({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
  it('cwd persistant de la ligne : mkdir -p ../../c1.captures depuis <clone>/frontend n\'est pas une fuite', () => {
    expect(chercherFuites([avecCwd(`${C}/frontend`, { command: 'mkdir -p ../../c1.captures' })], r, H, C).certaines).toEqual([]);
  });
  it('cwd persistant de la ligne : cat ../../../../secrets/... (cinq niveaux) depuis <clone>/frontend est une fuite', () => {
    expect(chercherFuites([avecCwd(`${C}/frontend`, { command: 'cat ../../../../../secrets/1-t/attendu.md' })], r, H, C).certaines).toEqual([S]);
  });
  it('cwd de la ligne dans un dossier interdit : fuite, même pour une lecture sans chemin', () => {
    expect(chercherFuites([avecCwd(`${H}/bench-cadence/secrets/1-t`, { command: 'cat attendu.md' })], r, H, C).certaines).toEqual([`${H}/bench-cadence/secrets/1-t`]);
  });
  it('cwd de la ligne dans le clone : pas de fuite', () => {
    expect(chercherFuites([avecCwd(`${C}/frontend`, { command: 'ls' })], r, H, C).certaines).toEqual([]);
  });
  it('chemins relatifs, « .. », cd, ${HOME} et accolades', () => {
    expect(chercherFuites([appel({ command: 'cat ../../../../secrets/1-t/attendu.md' })], r, H, C).certaines).toEqual([S]);
    expect(chercherFuites([appel({ file_path: `${C}/../c2/x` })], r, H, C).certaines).toEqual([`${H}/bench-cadence/runs/r1/1-t/c2/x`]);
    expect(chercherFuites([appel({ command: 'cd ~/bench-cadence && cat secrets/1-t/attendu.md' })], r, H, C).certaines).toEqual([S]);
    expect(chercherFuites([appel({ command: 'cat ${HOME}/bench-cadence/secrets/1-t/a' })], r, H, C).certaines).toEqual([`${H}/bench-cadence/secrets/1-t/a`]);
    expect(chercherFuites([appel({ command: 'ls ~/bench-cadence/{secrets,x}/f' })], r, H, C).certaines).toEqual([`${H}/bench-cadence/secrets/f`]);
    expect(chercherFuites([appel({ command: 'cd ../../../../secrets' })], r, H, C).certaines).toEqual([`${H}/bench-cadence/secrets`]);
  });
  it('cd dans son clone puis « .. » restant dedans : permis', () => {
    expect(chercherFuites([appel({ command: 'cd frontend && cat ../package.json' })], r, H, C).certaines).toEqual([]);
  });
  it('relatifs dans le contenu des fichiers : ignorés ; absolu ou ~ : fuite', () => {
    expect(chercherFuites([outil('Write', { file_path: `${C}/frontend/src/a/b.ts`, content: "import x from '../../shared/y'" })], r, H, C).certaines).toEqual([]);
    expect(chercherFuites([outil('Edit', { file_path: `${C}/a.ts`, old_string: 'a', new_string: "'../../../util'" })], r, H, C).certaines).toEqual([]);
    expect(chercherFuites([outil('Write', { file_path: `${C}/n.md`, content: 'voir ~/bench-cadence/secrets/1-t/attendu.md' })], r, H, C).certaines).toEqual([S]);
  });
  it('fuitesDuBras lit aussi les transcripts de sous-agents', () => {
    const home = mkdtempSync(join(tmpdir(), 'fu-'));
    const clone = `${home}/bench-cadence/runs/r1/1-t/c1`;
    const dir = `${dossierTranscripts(home, clone)}/sess/subagents`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/agent-x.jsonl`, appel({ command: `cat ${home}/bench-cadence/secrets/1-t/a` }) + '\n');
    expect(fuitesDuBras(home, `${home}/bench-cadence`, '1-t', clone)).toEqual({ certaines: [`${home}/bench-cadence/secrets/1-t/a`], a_verifier: [] });
  });
  describe('R21 : à vérifier (runs, non bloquant) contre certaines', () => {
    const run = `${H}/bench-cadence/runs/2026-11-07-2032-81f73ac8cce2`;
    const cl = `${run}/3-t/c1`;
    const rr = reglesDuBras(H, `${H}/bench-cadence`, '3-t', cl);
    const ver = (command: string, cwd = cl) => chercherFuites([avecCwd(cwd, { command })], rr, H, cl);
    it('lister les ancêtres de son clone : à vérifier seulement', () => {
      for (const d of [run, `${run}/3-t`, `${run}/3-t/r1`]) expect(ver(`ls ${d}`)).toEqual({ certaines: [], a_verifier: [d] });
    });
    it('pieces relatives résolues contre un ancêtre, et chemin relatif test/fixtures : à vérifier', () => {
      expect(ver('ls pieces/x.png', `${run}/3-t`)).toEqual({ certaines: [], a_verifier: [`${run}/3-t`, `${run}/3-t/pieces/x.png`] });
      expect(ver('cat test/fixtures/a.json', `${run}/3-t`).certaines).toEqual([]);
      expect(ver('cat test/fixtures/a.json', `${run}/3-t`).a_verifier).toEqual([`${run}/3-t`, `${run}/3-t/test/fixtures/a.json`]);
    });
    it('glob dont le préfixe est un ancêtre et dont aucun composant ne peut viser un clone voisin : à vérifier ; sinon (doute) certaine', () => {
      const rl = reglesDuBras(H, `${H}/bench-cadence`, '3-t', `${run}/3-t/r1/c1`);
      expect(chercherFuites([appel({ command: `ls ${run}/3-t/r1/x*/node_modules/*` })], rl, H)).toEqual({ certaines: [], a_verifier: [`${run}/3-t/r1`] });
      expect(chercherFuites([appel({ command: `ls ${run}/3-t/r1/*/node_modules/*` })], rl, H).certaines).toEqual([`${run}/3-t/r1`]);
      expect(ver('ls ../../c*', `${cl}/src`).certaines).toEqual([`${run}/3-t`]);
      expect(ver('ls ../../../*/c1', `${cl}/src`).certaines).toEqual([run]);
      expect(ver(`ls ${run}/3-t/*`).certaines).toEqual([`${run}/3-t`]);
      expect(ver(`ls ${run}/3-t/c2/src/*.ts`).certaines).toEqual([`${run}/3-t/c2/src`]);
      expect(ver(`ls ${run}/3-t/c2/*`).certaines).toEqual([`${run}/3-t/c2`]);
      expect(ver(`cat ${run}/4-t/c1/a.ts`).certaines).toEqual([`${run}/4-t/c1/a.ts`]);
    });
    it('c2.patch, c2.commits.txt, c2.captures, c2.question.md : certaines ; ses propres .captures, .question.md, logs : permis', () => {
      for (const f of ['c2.patch', 'c2.commits.txt', 'c2.captures', 'c2.question.md']) expect(ver(`cat ${run}/3-t/${f}`).certaines).toEqual([`${run}/3-t/${f}`]);
      expect(ver(`cat ${cl}.captures/a.png ${cl}.question.md ${cl}.install.log ${cl}.tests-base.log`)).toEqual({ certaines: [], a_verifier: [] });
    });
    it('eval et rapports : certaines', () => {
      expect(ver(`cat ${H}/bench-cadence/eval/x/y ${H}/bench-cadence/rapports/z.md`).certaines).toEqual([`${H}/bench-cadence/eval/x/y`, `${H}/bench-cadence/rapports/z.md`]);
    });
    it('cd c2 et ls c2 nus depuis le dossier du banc : certaines ; depuis son clone : permis', () => {
      expect(ver('cd c2', `${run}/3-t`).certaines).toEqual([`${run}/3-t/c2`]);
      expect(ver('ls c2', `${run}/3-t`).certaines).toEqual([`${run}/3-t/c2`]);
      expect(ver('ls c2 && cd c2', cl).certaines).toEqual([]);
    });
    it('secrets, transcripts d\'un autre clone : certaines ; son propre clone : rien', () => {
      expect(ver(`cat ${H}/bench-cadence/secrets/3-t/a ${H}/.claude/projects/-x-c2/s.jsonl`).certaines).toHaveLength(2);
      expect(ver(`ls ${cl}/src ${cl}.captures`)).toEqual({ certaines: [], a_verifier: [] });
    });
  });
});
