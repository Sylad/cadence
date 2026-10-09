import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cadenceHome } from './orchestrate/registry.js';

/** Au-delà, le chiffre écrit par la bande est trop vieux pour guider un arrêt (la bande le rafraîchit toutes les 5 s). */
export const HUD_CONTEXT_MAX_AGE_MS = 120_000;
/** Un fichier de session plus vieux que cela est ignoré et supprimé à la lecture (une session fermée ne le rafraîchit plus). */
export const HUD_CONTEXT_PURGE_MS = 24 * 3600_000;

export interface HudContext {
  cwd: string;
  percent: number;
  tokens: number;
  window: number;
  at: number;
}

/** Dossier où la bande cadence-hud publie le contexte de chaque session : un fichier `<id de session>.json` par session. */
export function hudContextDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cadenceHome(env), 'hud-context');
}

/** Le nom de fichier d'une session : le même nettoyage que le script d'écriture de la bande (lettres, chiffres, `-`, `_`). */
export function hudContextFile(session: string): string {
  return `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

function sameFolder(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Retire les fichiers de plus de 24 h (selon `at`, ou la date du fichier quand `at` manque) ; rend les autres. */
function livingFiles(dir: string, nowMs: number): string[] {
  const kept: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    let at: number | undefined;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown };
      if (isNum(raw?.at)) at = raw.at;
    } catch {
      /* illisible : l'âge du fichier décide */
    }
    try {
      at ??= statSync(file).mtimeMs;
      if (nowMs - at > HUD_CONTEXT_PURGE_MS) {
        unlinkSync(file);
        continue;
      }
    } catch {
      continue;
    }
    kept.push(file);
  }
  return kept;
}

/**
 * Le contexte publié par la bande pour la session qui tourne dans `cwd` (le plus récent s'il y en a plusieurs),
 * ou pour la session `session` quand on la désigne ; sinon une raison de ne pas le croire
 * (aucune session, illisible, incomplet, périmé).
 */
export function readHudContext(env: NodeJS.ProcessEnv, nowMs: number, target: { cwd: string; session?: string }): { ok: true; ctx: HudContext } | { ok: false; reason: string } {
  const dir = hudContextDir(env);
  if (!existsSync(dir)) return { ok: false, reason: `${dir} absent (le mod cadence-hud est-il chargé ?)` };
  const files = livingFiles(dir, nowMs);
  let file: string | undefined;
  let unreadable = 0;
  if (target.session !== undefined) {
    file = join(dir, hudContextFile(target.session));
    if (!files.includes(file)) return { ok: false, reason: `aucun contexte publié pour la session ${target.session} (${file} absent)` };
  } else {
    const candidates: { file: string; at: number }[] = [];
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<HudContext>;
        if (typeof raw?.cwd === 'string' && sameFolder(raw.cwd, target.cwd)) candidates.push({ file: f, at: isNum(raw.at) ? raw.at : -Infinity });
      } catch {
        unreadable++;
      }
    }
    candidates.sort((a, b) => b.at - a.at);
    file = candidates[0]?.file;
    if (!file) {
      const more = unreadable ? ` ; ${unreadable} fichier(s) illisible(s)` : '';
      return { ok: false, reason: `aucune session de la bande ne publie pour ${target.cwd} dans ${dir} (le mod cadence-hud est-il chargé dans cette session ?)${more}` };
    }
  }
  let raw: Partial<HudContext>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HudContext>;
  } catch {
    return { ok: false, reason: `${file} illisible` };
  }
  const { cwd, percent, tokens, window, at } = raw;
  if (typeof cwd !== 'string' || ![percent, tokens, window, at].every(isNum)) return { ok: false, reason: `${file} incomplet` };
  const age = nowMs - (at as number);
  if (age > HUD_CONTEXT_MAX_AGE_MS) return { ok: false, reason: `${file} périmé (${Math.round(age / 1000)} s)` };
  return { ok: true, ctx: { cwd, percent: percent as number, tokens: tokens as number, window: window as number, at: at as number } };
}
