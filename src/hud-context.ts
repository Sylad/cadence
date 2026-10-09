import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cadenceHome } from './orchestrate/registry.js';

/** Au-delà, le chiffre écrit par la bande est trop vieux pour guider un arrêt (la bande le rafraîchit toutes les 5 s). */
export const HUD_CONTEXT_MAX_AGE_MS = 120_000;

export interface HudContext {
  percent: number;
  tokens: number;
  window: number;
  at: number;
}

/** Fichier où la bande cadence-hud publie le contexte de la session (la bande n'est qu'un rendu : sans lui, le modèle ne lit rien). */
export function hudContextPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cadenceHome(env), 'hud-context.json');
}

/** Le contexte publié par la bande, ou une raison de ne pas le croire (absent, illisible, périmé). */
export function readHudContext(env: NodeJS.ProcessEnv, nowMs: number): { ok: true; ctx: HudContext } | { ok: false; reason: string } {
  const file = hudContextPath(env);
  if (!existsSync(file)) return { ok: false, reason: `${file} absent (le mod cadence-hud est-il chargé ?)` };
  let raw: Partial<HudContext>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HudContext>;
  } catch {
    return { ok: false, reason: `${file} illisible` };
  }
  const { percent, tokens, window, at } = raw;
  if (![percent, tokens, window, at].every((n) => typeof n === 'number' && Number.isFinite(n))) return { ok: false, reason: `${file} incomplet` };
  const age = nowMs - (at as number);
  if (age > HUD_CONTEXT_MAX_AGE_MS) return { ok: false, reason: `${file} périmé (${Math.round(age / 1000)} s)` };
  return { ok: true, ctx: { percent: percent as number, tokens: tokens as number, window: window as number, at: at as number } };
}
