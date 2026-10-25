import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lotSlug } from '../src/orchestrate/state.js';

export interface PStep {
  kind: string;
  status?: string;
  ended?: string;
  counted?: number;
  model?: string;
  started?: string;
  /** Compteurs écrits tels quels dans le journal (remplace `counted`) ; `null` : pas de champ `tokens`. */
  tokens?: Record<string, number> | null;
  /** Écrit un `model` absent du journal (journal très ancien). */
  noModel?: boolean;
  constats?: string[];
}

export interface PJournal {
  status?: string;
  budget?: number;
  visible?: boolean;
  /** Petit lot (champ `small` du journal) ; absent d'un journal ancien. */
  small?: boolean;
  /** Verdict du précheck écrit dans le journal (`precheckVerdict`) ; absent d'un journal ancien. */
  precheck?: string;
  /** Avertissements du journal du lot (`warnings`). */
  warnings?: string[];
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
    const tokens = s.tokens !== undefined ? s.tokens ?? undefined : s.counted === undefined ? undefined : { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, counted: s.counted };
    return { n, kind: s.kind, status: s.status ?? 'ok', ...(s.noModel ? {} : { model: s.model ?? 'sonnet' }), started: s.started, ended: s.ended, tokens, report, commits: [] };
  });
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify({ project, lot, visible: o.visible ?? false, ...(o.small === undefined ? {} : { small: o.small }), status: o.status ?? 'ready', ...(o.budget === undefined ? {} : { budget: o.budget }), ...(o.precheck === undefined ? {} : { precheckVerdict: o.precheck }), ...(o.warnings ? { warnings: o.warnings } : {}), steps }));
}
