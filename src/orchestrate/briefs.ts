import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RafError, type Lot } from '../plan.js';
import type { StepKind } from './launch.js';

/** Gabarits livrés avec le paquet (à la racine, à côté de dist/ et src/). */
export const TEMPLATES_DIR = fileURLToPath(new URL('../../templates/orchestrate', import.meta.url));

export interface BriefVars {
  chemin: string;
  lot: string;
  titre: string;
  objectif: string;
  commits: string;
  reponse: string;
  constats: string;
  ux: string;
}

const FILES: Record<StepKind, string> = {
  implement: 'implement.md',
  fix: 'fix.md',
  review: 'review.md',
  ux: 'ux.md',
  'review-small': 'review-small.md',
};

/** Rend le gabarit d'une étape par substitution de `{{nom}}`. Un nom sans valeur est une erreur. */
export function renderBrief(kind: StepKind, vars: BriefVars, dir = TEMPLATES_DIR): string {
  const text = readFileSync(join(dir, FILES[kind]), 'utf8');
  const out = text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = (vars as unknown as Record<string, string | undefined>)[name];
    if (v === undefined) throw new RafError(`gabarit ${FILES[kind]} : valeur manquante pour {{${name}}}`);
    return v;
  });
  // Un marqueur vide ne laisse pas de trou : lignes vides en double ramenées à une.
  return `${out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** `{{objectif}}` : le titre du lot, ses notes et ses sous-tâches — Sylvain n'écrit rien d'autre. */
export function objective(lot: Lot): string {
  const lines = [`${lot.title}`];
  if (lot.notes.length) lines.push('', 'Notes of the lot (decisions included):', ...lot.notes.map((n) => `- ${n.date}: ${n.text}`));
  if (lot.tasks.length) lines.push('', 'Sub-tasks:', ...lot.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`));
  return lines.join('\n');
}
