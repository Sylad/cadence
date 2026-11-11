// Fin de quota d'une session claude -p (D-15, L700). Doc officielle lue le 11-11 : en claude -p, elle ne se reconnaît qu'au texte du résultat,
// « You've hit your weekly limit · resets <jour heure> » (limite hebdo : tous les modèles) ou « You've hit your Opus limit » (Opus seul).
// Le résultat COMMENCE par ce texte : un compte rendu qui le cite plus loin n'est pas une fin de quota.

export type Limite = 'hebdo' | 'opus';
export interface Quota { limite: Limite; reprise: string | null; texte: string }

const MESSAGE = /^You['’]ve hit your (weekly|Opus) limit\b/i;
const JOURS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MOIS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Décalage du fuseau à l'instant `t` (ms), en ms : heure murale du fuseau moins UTC. */
function decalage(t: number, fuseau: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: fuseau, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
/** L'instant UTC d'une heure murale du fuseau (deux passes : le décalage change au passage d'heure d'été). */
function instant(a: number, m: number, j: number, h: number, mn: number, fuseau: string): number {
  const mur = Date.UTC(a, m, j, h, mn);
  const t = mur - decalage(mur, fuseau);
  return mur - decalage(t, fuseau);
}
/** La date du jour (année, mois, jour, jour de la semaine) dans le fuseau, à l'instant `t`. */
function aujourdhui(t: number, fuseau: string): { a: number; m: number; j: number; js: number } {
  const d = new Date(t + decalage(t, fuseau));
  return { a: d.getUTCFullYear(), m: d.getUTCMonth(), j: d.getUTCDate(), js: d.getUTCDay() };
}

/** L'heure de remise à zéro lue dans « resets … » : la prochaine occurrence après `maintenant`, ou null quand l'heure est illisible. */
function lireReprise(texte: string, maintenant: Date): string | null {
  const apres = /resets\s+(.+)$/im.exec(texte)?.[1];
  if (!apres) return null;
  const fz = /\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\)/.exec(apres)?.[1];
  let fuseau = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (fz) try { new Intl.DateTimeFormat('en-US', { timeZone: fz }); fuseau = fz; } catch { /* fuseau inconnu : celui de la machine */ }
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(apres), h24 = /\b(\d{1,2}):(\d{2})\b/.exec(apres);
  if (!ampm && !h24) return null;
  let h = Number((ampm ?? h24)![1]); const mn = Number((ampm ?? h24)![2] ?? 0);
  if (ampm) h = (h % 12) + (ampm[3].toLowerCase() === 'pm' ? 12 : 0);
  if (h > 23 || mn > 59) return null;
  const t = maintenant.getTime(), auj = aujourdhui(t, fuseau);
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(apres);
  const js = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i.exec(apres);
  let r: number;
  if (md) {
    const m = MOIS.indexOf(md[1].toLowerCase()), j = Number(md[2]);
    r = instant(auj.a, m, j, h, mn, fuseau);
    if (r <= t) r = instant(auj.a + 1, m, j, h, mn, fuseau);
  } else {
    const ecart = js ? (JOURS.indexOf(js[1].toLowerCase()) - auj.js + 7) % 7 : 0;
    r = instant(auj.a, auj.m, auj.j + ecart, h, mn, fuseau);
    if (r <= t) r = instant(auj.a, auj.m, auj.j + ecart + (js ? 7 : 1), h, mn, fuseau);
  }
  return new Date(r).toISOString();
}

/** Le quota que le résultat d'une session annonce, ou null quand ce n'en est pas un. */
export function reconnaitreQuota(resultat: string, maintenant: Date): Quota | null {
  const texte = resultat.trim(), m = MESSAGE.exec(texte);
  if (!m) return null;
  return { limite: m[1].toLowerCase() === 'weekly' ? 'hebdo' : 'opus', reprise: lireReprise(texte, maintenant), texte };
}

/** Une heure locale lisible, sans dépendre de la langue de la machine : 2026-11-13 09:01. */
export function heureLocale(iso: string): string {
  const d = new Date(iso), z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
