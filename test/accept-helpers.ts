import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { git } from './orchestrate-harness.js';
import { EXEMPLE } from './spec-helpers.js';

export const DIR = 'docs/specs';

export interface Opts { lot?: string; vert?: boolean; tests?: string; ecran?: string; sansFiche?: boolean }

/** Ce que fait l'agent accept : fiche + fichiers de tests + acceptation.json, dans un seul commit rouge. */
export function ecritAcceptation(repo: string, o: Opts = {}): { json: string; fiche: string; sha: string; test: string } {
  const lot = o.lot ?? 'L1';
  const ecran = o.ecran ?? 'prochain-match';
  const dir = join(repo, DIR, ecran);
  mkdirSync(join(repo, 'test'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  const fiche = parse(readFileSync(EXEMPLE, 'utf8')) as any;
  const noms = (fiche.regles as any[]).flatMap((r) => r.tests as string[]);
  const test = `test/${ecran}.acceptation.test.ts`;
  writeFileSync(join(repo, test), o.tests ?? noms.map((n) => `it('${n}', () => { throw new Error('rouge'); });`).join('\n'));
  if (!o.sansFiche) writeFileSync(join(dir, 'fiche.yaml'), readFileSync(EXEMPLE, 'utf8'));
  const json = `${DIR}/${ecran}/acceptation.json`;
  writeFileSync(join(repo, json), JSON.stringify({ lot, fiche: `${DIR}/${ecran}/fiche.yaml`, fichiers: [test], vert: o.vert ?? false }, null, 2));
  const paths = [test, json, ...(o.sansFiche ? [] : [`${DIR}/${ecran}/fiche.yaml`])];
  git(repo, 'add', '--', ...paths);
  git(repo, 'commit', '-q', '--allow-empty', '-m', `test(${lot}): acceptation R1–R4 (rouge)`, '--', ...paths);
  return { json, fiche: `${DIR}/${ecran}/fiche.yaml`, sha: git(repo, 'rev-parse', 'HEAD'), test };
}

