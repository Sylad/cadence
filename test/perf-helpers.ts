import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lotSlug } from '../src/orchestrate/state.js';

export interface PStep {
  kind: string;
  status?: string;
  ended?: string;
  counted?: number;
  constats?: string[];
}

export interface PJournal {
  status?: string;
  budget?: number;
  visible?: boolean;
  steps: PStep[];
}

/** wave.json d'une vague ; `created` null écrit un fichier illisible. */
export function writeWave(runs: string, wave: string, created: string | null = '2026-10-01T08:00:00.000Z'): void {
  mkdirSync(join(runs, wave), { recursive: true });
  writeFileSync(join(runs, wave, 'wave.json'), created === null ? '{pas du json' : JSON.stringify({ id: wave, created }));
}

/** Un journal <vague>/<projet>--<lot>.json (nom de fichier par lotSlug) et le rapport de chaque revue qui porte des constats. */
export function writeJournal(runs: string, wave: string, project: string, lot: string, o: PJournal): void {
  const slug = lotSlug(project, lot);
  const dir = join(runs, wave);
  mkdirSync(join(dir, slug), { recursive: true });
  const steps = o.steps.map((s, i) => {
    const n = i + 1;
    const report = `${n}-${s.kind}.json`;
    if (s.constats) {
      const structured = { constats: s.constats.map((texte) => ({ gravite: 'majeur', texte })) };
      writeFileSync(join(dir, slug, report), JSON.stringify({ structured }));
    }
    return { n, kind: s.kind, status: s.status ?? 'ok', ended: s.ended, tokens: s.counted === undefined ? undefined : { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, counted: s.counted }, report, commits: [] };
  });
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify({ project, lot, visible: o.visible ?? false, status: o.status ?? 'ready', ...(o.budget === undefined ? {} : { budget: o.budget }), steps }));
}
