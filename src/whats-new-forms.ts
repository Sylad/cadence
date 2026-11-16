/**
 * L753 — `cadence release` écrit elle-même les formes de la version qui manquent à docs/whats-new.md, tirées des entrées de la
 * section de version (les fragments de changelog.d/ assemblés, plus ce que [Unreleased] portait) : la ligne de « In two lines »
 * (≤ 240 caractères) et le paragraphe long en tête de « Version by version ». Le 16-11, 2.0.11 puis 2.0.12 s'étaient arrêtées
 * sur ces deux formes absentes, et un agent les avait écrites chaque fois. Une forme déjà présente dans le fichier, même mal
 * placée, n'est jamais réécrite ni doublée : la vérification la signale comme avant.
 */

/** Longueur maximale (en caractères) de la ligne d'une version dans la liste courte de docs/whats-new.md. */
export const SHORT_LINE_MAX = 240;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Les entrées d'un corps de section Keep a Changelog : chaque puce `- …`, ses lignes de suite jointes par une espace. */
export function changelogEntries(body: string): string[] {
  const entries: string[] = [];
  let current: string | null = null;
  const close = () => {
    if (current !== null && current.trim() !== '') entries.push(current.trim());
    current = null;
  };
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (/^#{1,6}\s/.test(line) || line.trim() === '') close();
    else if (/^[-*]\s+/.test(line)) {
      close();
      current = line.replace(/^[-*]\s+/, '');
    } else if (current !== null) current += ` ${line.trim()}`;
  }
  close();
  return entries;
}

/** Les liens relatifs d'une entrée du CHANGELOG (écrits depuis la racine) réécrits pour docs/whats-new.md. */
export function relinkForDocs(text: string): string {
  return text.replace(/\]\(([^)\s]+)\)/g, (all, target: string) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return all;
    return `](${target.startsWith('docs/') ? target.slice('docs/'.length) : `../${target}`})`;
  });
}

type CutKind = 'clause' | 'comma' | 'space';
interface Cut { at: number; kind: CutKind }

/** La coupure que permet le caractère `i` hors code et hors (…), […], « … » : null quand il n'en permet aucune. */
function cutAt(text: string, i: number): Cut | null {
  const c = text[i];
  const next = text[i + 1];
  if (c === '(' && text[i - 1] === ' ') return { at: i - 1, kind: 'clause' };
  if ((c === ';' || c === '.') && (next === ' ' || next === undefined)) return { at: i, kind: 'clause' };
  if (c === ' ') return { at: i, kind: next === '—' ? 'clause' : 'space' };
  if (c === ',' && next === ' ') return { at: i, kind: 'comma' };
  return null;
}

/**
 * Les positions où le texte peut être coupé, hors code (`…`), lien ([…](…)), parenthèses et guillemets « … » :
 * `clause` avant « ( », « ; », « . », « — » (fin de la proposition de tête), `comma` avant « , », `space` avant une espace.
 */
function cuts(text: string): Cut[] {
  const out: Cut[] = [];
  let code = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '`') code = !code;
    if (code) continue;
    const cut = depth === 0 ? cutAt(text, i) : null;
    if (cut) out.push(cut);
    if ('([«'.includes(c)) depth++;
    else if (')]»'.includes(c)) depth = Math.max(0, depth - 1);
  }
  return out;
}

const tidy = (s: string) => s.replace(/[\s,;:.—]+$/, '');

/** La proposition de tête d'une entrée : jusqu'à la première fin de proposition hors code, lien, parenthèses et guillemets. */
export function entryHead(entry: string): string {
  const first = cuts(entry).find((c) => c.kind === 'clause');
  return tidy(first ? entry.slice(0, first.at) : entry);
}

/** Coupe une tête trop longue à la dernière virgule, sinon à la dernière espace, qui tient dans `room` (points de suspension compris). */
function shorten(head: string, room: number): string | null {
  const fits = cuts(head).filter((c) => c.at + 1 <= room);
  const at = [...fits].reverse().find((c) => c.kind === 'comma') ?? [...fits].reverse().find((c) => c.kind === 'space');
  if (!at) return null;
  const cut = tidy(head.slice(0, at.at));
  return cut === '' ? null : `${cut}…`;
}

/**
 * La ligne de « In two lines » : les têtes des entrées, dans l'ordre de la section, chacune gardée si elle tient encore dans les
 * 240 caractères (une tête trop longue est sautée, les suivantes sont essayées) ; la première tête, seule trop longue, est coupée.
 */
export function shortLine(version: string, entries: string[]): string | null {
  const prefix = `- **${version}**: `;
  const heads = entries.map((e) => relinkForDocs(entryHead(e))).filter((h) => h !== '');
  const kept: string[] = [];
  for (const h of heads) {
    if (`${prefix}${[...kept, h].join('; ')}.`.length <= SHORT_LINE_MAX) kept.push(h);
    else if (kept.length === 0) {
      const cut = shorten(h, SHORT_LINE_MAX - prefix.length - 1);
      if (cut) {
        kept.push(cut);
        break;
      }
    }
  }
  if (kept.length === 0) return null;
  const line = `${prefix}${kept.join('; ')}`;
  return line.endsWith('…') ? line : `${line}.`;
}

/** Le paragraphe long : toutes les entrées, dans l'ordre de la section, en une ligne, chacune close par un point. */
export function longParagraph(version: string, entries: string[]): string | null {
  if (entries.length === 0) return null;
  const parts = entries.map((e) => relinkForDocs(e).trim()).map((e) => (/[.!?…]$/.test(e) ? e : `${e}.`));
  return `**${version}**: ${parts.join(' ')}`;
}

export interface WhatsNewDraft {
  /** Le texte de docs/whats-new.md avec les formes écrites (identique à l'entrée si rien n'est écrit). */
  text: string;
  /** Les formes écrites par la commande, dans l'ordre : « ligne de « In two lines » », « paragraphe long ». */
  written: string[];
}

/**
 * Écrit dans docs/whats-new.md les formes de `version` qui n'y sont nulle part, à leur place : la ligne en tête de la liste de
 * « In two lines », le paragraphe juste après l'introduction de « Version by version ». Une forme déjà présente (même mal placée,
 * même dans l'autre section), une section absente ou une section de version sans entrée : rien n'est écrit pour cette forme.
 */
export function draftWhatsNew(text: string, version: string, body: string): WhatsNewDraft {
  const entries = changelogEntries(body);
  const lines = text.split('\n');
  const v = esc(version);
  const hasShort = lines.some((l) => new RegExp(`^- \\*\\*${v}\\*\\*`).test(l));
  const hasLong = lines.some((l) => new RegExp(`^\\*\\*${v}\\*\\*:`).test(l));
  const long = hasLong ? null : longParagraph(version, entries);
  const wroteLong = long !== null && insertLong(lines, long);
  const short = hasShort ? null : shortLine(version, entries);
  const wroteShort = short !== null && insertShort(lines, short);
  const written = [...(wroteShort ? ['ligne de « In two lines »'] : []), ...(wroteLong ? ['paragraphe long'] : [])];
  return { text: lines.join('\n'), written };
}

/** Une ligne qui ouvre le paragraphe long d'une version (`**x.y.z**:`) : jamais une ligne de l'introduction. */
export const LONG_PARAGRAPH = /^\*\*(\d+\.\d+\.\d+)\*\*:/;
const IN_TWO_LINES = /^##\s+In two lines\s*$/;
const VERSION_BY_VERSION = /^##\s+Version by version\s*$/;

/**
 * L761 : la structure que la commande sait remplir — « ## In two lines » puis « ## Version by version », une fois chacun. Rend
 * l'écart en une phrase, ou null ; la commande le refuse avant tout écrit plutôt que d'écrire au mauvais endroit.
 */
export function whatsNewStructureIssue(text: string): string | null {
  const lines = text.split('\n');
  const at = (re: RegExp) => lines.flatMap((l, i) => (re.test(l) ? [i] : []));
  const short = at(IN_TWO_LINES);
  const long = at(VERSION_BY_VERSION);
  for (const [name, hits] of [['## In two lines', short], ['## Version by version', long]] as const) {
    if (hits.length === 0) return `titre « ${name} » introuvable`;
    if (hits.length > 1) return `titre « ${name} » présent ${hits.length} fois (lignes ${hits.map((i) => i + 1).join(', ')})`;
  }
  if (long[0] < short[0]) return `« ## Version by version » (ligne ${long[0] + 1}) avant « ## In two lines » (ligne ${short[0] + 1})`;
  return null;
}

/**
 * Le paragraphe long en tête des paragraphes de version de « Version by version » : avant le premier `**x.y.z**:`, l'introduction
 * (tout ce qui précède, sur un ou plusieurs paragraphes, ou rien) restant au-dessus ; à la fin de la section quand elle n'a encore
 * aucune version. Faux sans cette section. L761 : sans introduction, l'ancien premier paragraphe n'est plus pris pour elle.
 */
function insertLong(lines: string[], long: string): boolean {
  const heading = lines.findIndex((l) => VERSION_BY_VERSION.test(l));
  if (heading < 0) return false;
  const next = lines.findIndex((l, i) => i > heading && /^##\s/.test(l));
  const end = next < 0 ? lines.length : next;
  const first = lines.findIndex((l, i) => i > heading && i < end && LONG_PARAGRAPH.test(l));
  if (first >= 0) {
    lines.splice(first, 0, long, '');
    return true;
  }
  let last = end - 1;
  while (last > heading && lines[last].trim() === '') last--;
  lines.splice(last + 1, 0, '', long);
  return true;
}

/** La ligne en tête de la liste de « In two lines » (sous son titre si la liste est vide) ; faux sans cette section. */
function insertShort(lines: string[], short: string): boolean {
  const heading = lines.findIndex((l) => /^##\s+In two lines\s*$/.test(l));
  if (heading < 0) return false;
  const next = lines.findIndex((l, i) => i > heading && l.startsWith('## '));
  const end = next < 0 ? lines.length : next;
  const first = lines.findIndex((l, i) => i > heading && i < end && /^- \*\*\d+\.\d+\.\d+\*\*/.test(l));
  if (first >= 0) lines.splice(first, 0, short);
  else lines.splice(heading + 1, 0, '', short);
  return true;
}
