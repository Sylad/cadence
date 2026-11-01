// Ce que la porte de tests dit d'un rouge qu'elle n'envoie pas en correction : instable sous charge (L354), délai trop juste (L510).

import type { LotCtx } from './cycle.js';
import { lotKey } from './state.js';
import type { TightTest } from './workers.js';

type NoteCtx = Pick<LotCtx, 'lot' | 'wave'>;

/** Trace des tests instables sous charge (L354) : le lot (`instables`, journal et `cadence perf`), un avertissement du lot (tableau de fin de vague) et une ligne du journal de la vague. */
export function noteUnstable(c: NoteCtx, tests: string[]): void {
  const l = c.lot;
  const fresh = tests.filter((t) => !(l.instables ?? []).includes(t));
  if (!fresh.length) return;
  l.instables = [...(l.instables ?? []), ...fresh];
  const text = `${fresh.length} test(s) instable(s) sous charge (rouge(s) dans la suite, vert(s) rejoué(s) seul(s)), pas de passe de correction : ${fresh.join(' ; ')}`;
  l.warnings.push(text);
  c.wave.log(`${lotKey(l.project, l.lot)} · ${text}`);
  c.wave.store.writeLot(l);
}

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`.replace(/\.0 s$/, ' s');

/** Trace des tests au « délai trop juste » (L510) : rouges dans la suite pour avoir expiré, verts seuls mais près de leur délai. Le lot (`delaisJustes`) et un avertissement qui nomme chaque test, sa durée seul et son délai ; jamais de passe de correction. */
export function noteTight(c: NoteCtx, tests: TightTest[]): void {
  const l = c.lot;
  const fresh = tests.filter((t) => !(l.delaisJustes ?? []).some((k) => k.test === t.test));
  if (!fresh.length) return;
  l.delaisJustes = [...(l.delaisJustes ?? []), ...fresh];
  const text = `délai trop juste, pas un bug (pas de passe de correction) : ${fresh.map((t) => `${t.test} (${seconds(t.ms)} seul pour ${seconds(t.limit)} de délai)`).join(' ; ')} — relever le délai du test`;
  l.warnings.push(text);
  c.wave.log(`${lotKey(l.project, l.lot)} · ${text}`);
  c.wave.store.writeLot(l);
}
