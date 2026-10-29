import type { FailedDelivery, LotsBoard, Wave } from '../types'
import { ellipsize } from './lots'
import { lotStatusFr } from './format'

// ── L412 : « ce qui attend une décision », en tête du panneau des lots ───────────────────────────────────────────

export type Decision =
  | { kind: 'question'; project: string; lot: string; text: string; /** la commande qui répond (celle du tableau de fin de vague) */ command: string }
  | { kind: 'rendu'; project: string; lot: string; text: string }
  | { kind: 'ux'; project: string; lot: string; text: string; command: string }
  | { kind: 'livraison'; project: string; text: string }

/** La première ligne non vide d'un texte. */
const firstLine = (text: string): string => text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''

/** Un argument rendu tel quel par sh, quels que soient ses espaces, guillemets ou jokers (la règle de src/deliver.ts) : un chemin ordinaire reste nu. */
const shellQuote = (arg: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)

/** La commande à copier, précédée de `cd <dossier> && ` : elle s'exécute telle quelle depuis n'importe quel dossier (le précédent de src/cli.ts, legacyPlanLine). Sans dossier, la commande nue. */
const from = (folder: string | null | undefined, command: string): string => (folder ? `cd ${shellQuote(folder)} && ${command}` : command)

/**
 * Ce qui attend une décision de la personne, lu dans les vagues de la bande (`waves` : les vivantes, et sans vivante la dernière finie du dossier), dans `ended` (les vagues
 * finies du dossier que le collecteur rend à part, la plus récente d'abord, qu'une vague vive ou non, L412 : lues sans le délai de 30 min de la bande, une question ou un lot rendu
 * attend tant que le plan le tient ouvert — une vague plus récente qui finit sans porter le lot ne l'efface pas) et dans les livraisons en échec : une question de session
 * (`question`), un lot rendu au lead (`handed-back`, `failed` : la cause est la première ligne de son issue, à défaut son statut), un verdict UX à poser (lot prêt, visible, dont
 * la revue a rendu un verdict) et une livraison en échec par projet.
 * Les vagues vivantes passent d'abord, puis les finies de la plus récente à la plus ancienne (une vague n'est lue qu'une fois) ; un lot n'est compté que dans la première vague qui
 * le porte (repris dans une vague plus récente, c'est elle qui tranche) ; un lot suspendu n'attend rien de la personne.
 * Le plan tranche (`board`, le tableau du panneau lu de `cadence lead tour --json`) : une décision dont le lot n'est plus ouvert dans un projet que le tour a lu (ligne sans erreur,
 * avec ses lots) n'est plus affichée — un verdict UX posé puis `raf done`, un lot rendu puis repris et clos, une question dont le lot est clos. Un projet absent du tableau, en erreur
 * ou sans lots (cadence trop ancien) garde ses décisions : on ne sait pas. Une livraison en échec ne dépend pas du plan.
 * Les commandes à copier commencent par `cd` : `--answer` depuis le dossier de lancement de la vague (`cwd`, le seul d'où orchestrate retrouve `<cwd>/.cadence/runs/<vague>`),
 * `raf ux` depuis le dépôt du lot (`repo` de son état) — depuis le dossier parent des projets, raf répondait « pas de plan », et depuis un autre projet il posait le verdict
 * sur le lot de même id de ce projet. Un état de lot sans `repo` (orchestrate l'écrit toujours) garde la commande nue.
 */
export const decisionsOf = (waves: readonly Wave[], deliveries: readonly FailedDelivery[], ended: readonly Wave[] = [], board: LotsBoard | null = null): Decision[] => {
  const open = (project: string, lot: string): boolean => {
    const row = board?.rows.find(r => r.project === project && !r.error && Array.isArray(r.lots))
    return !row || row.lots!.some(t => t.id === lot)
  }
  const finished = [...waves.filter(w => !w.live), ...ended]
  const ids = new Set<string>()
  const ordered = [...waves.filter(w => w.live), ...finished].filter(w => !ids.has(w.id) && ids.add(w.id))
  const seen = new Set<string>()
  const out: Decision[] = []
  for (const w of ordered) {
    for (const l of w.lots) {
      const key = `${l.project}:${l.lot}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!open(l.project, l.lot)) continue
      if (l.status === 'question') {
        const text = (l.questions ?? []).map(firstLine).filter(q => q !== '').join(' / ')
        out.push({ kind: 'question', project: l.project, lot: l.lot, text: text || 'question sans texte', command: from(w.cwd, `cadence orchestrate --resume --wave ${w.id} --answer ${key} "…"`) })
      } else if (l.status === 'handed-back' || l.status === 'failed') {
        out.push({ kind: 'rendu', project: l.project, lot: l.lot, text: firstLine(l.outcome ?? '') || lotStatusFr(l.status) })
      } else if (l.status === 'ready' && l.visible === true && typeof l.uxVerdict === 'string' && l.uxVerdict !== '') {
        out.push({ kind: 'ux', project: l.project, lot: l.lot, text: firstLine(l.uxVerdict), command: from(l.repo, `raf ux ${l.lot} "verdict"`) })
      }
    }
  }
  for (const d of deliveries) out.push({ kind: 'livraison', project: d.project, text: `${d.sha} · ${d.reason} (${d.day})` })
  return out
}

/** Les livraisons en échec lues par le script DELIVERIES ; une sortie illisible ou étrangère n'en donne aucune (le panneau garde le reste). */
export const parseDeliveries = (stdout: string): FailedDelivery[] => {
  try {
    const raw: unknown = JSON.parse(stdout)
    return (Array.isArray(raw) ? raw : []).filter(
      (d): d is FailedDelivery => typeof d === 'object' && d !== null && ['project', 'day', 'sha', 'reason'].every(k => typeof (d as Record<string, unknown>)[k] === 'string'),
    ).map(d => ({ project: d.project, day: d.day, sha: d.sha, reason: d.reason }))
  } catch {
    return []
  }
}

export type DecisionLine = { text: string; tone: 'title' | 'error' | 'text' | 'subtle' }

const GLYPH: Record<Decision['kind'], string> = { question: '?', rendu: '↩', ux: '◐', livraison: '✖' }

/** Le retrait de la commande à copier sous sa décision. */
const INDENT = '   '

/** La continuation de ligne du shell, en fin de chaque ligne repliée sauf la dernière : collées, les lignes ne font qu'une commande. */
const CONTINUATION = ' \\'

/**
 * La commande à copier, repliée sur des lignes de `columns` colonnes au plus (retrait et continuation compris), jamais coupée par « … » : une commande tronquée ne se copie pas.
 * Le repli se fait aux espaces ; un mot plus long qu'une ligne est coupé à la largeur. Chaque ligne sauf la dernière finit par la continuation ` \` (`\` collé au morceau
 * quand un mot est coupé) : collées telles quelles dans un shell, les lignes ne lancent qu'UNE commande, la commande d'origine — sans elle, une ligne 1
 * `cadence orchestrate --resume --wave <vague>` s'exécutait seule, sans son `--answer`. Les lignes, sans leur retrait, jointes en effaçant chaque `\` de fin de ligne
 * et le saut qui le suit (ce que fait le shell), redonnent la commande ; jointes par un espace, elles ne la redonnent pas quand un mot est coupé.
 * Un mot n'est coupé que quand la largeur passe sous le plus long argument (le chemin du `cd`, `projet:lot`, retrait et continuation compris) ; une coupe entre guillemets simples
 * ne se recollerait pas : seul un chemin avec espace ou apostrophe en porte, et il se coupe alors dès que la largeur passe sous sa longueur.
 * Sous 6 colonnes (retrait + 1 + continuation), les lignes sont coupées par « … » : rien n'y est lisible de toute façon.
 */
export const wrapCommand = (command: string, columns: number): string[] => {
  const width = Math.max(1, columns - INDENT.length - CONTINUATION.length)
  const lines: { text: string; cut: boolean }[] = []
  let line = ''
  const flush = (cut = false) => {
    if (line !== '') lines.push({ text: line, cut })
    line = ''
  }
  for (let word of command.split(' ')) {
    while (word.length > width) {
      flush()
      line = word.slice(0, width)
      flush(true)
      word = word.slice(width)
    }
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      flush()
      line = word
    }
  }
  flush()
  const last = lines.length - 1
  return lines.map((l, i) => ellipsize(`${INDENT}${l.text}${i < last ? (l.cut ? CONTINUATION.trimStart() : CONTINUATION) : ''}`, columns))
}

/** Les lignes d'une décision : son résumé (coupé à la largeur), puis la commande à copier, repliée, pour une question ou un verdict UX. */
const linesOf = (d: Decision, columns: number): DecisionLine[] => {
  const where = d.kind === 'livraison' ? d.project : `${d.project}:${d.lot}`
  const label = d.kind === 'livraison' ? 'livraison' : d.kind === 'ux' ? 'verdict UX' : ''
  const head = ellipsize(`${GLYPH[d.kind]} ${where}  ${label ? `${label} : ` : ''}${d.text}`, columns)
  const lines: DecisionLine[] = [{ text: head, tone: d.kind === 'livraison' || d.kind === 'rendu' ? 'error' : 'text' }]
  if (d.kind === 'question' || d.kind === 'ux') lines.push(...wrapCommand(d.command, columns).map((text): DecisionLine => ({ text, tone: 'subtle' })))
  return lines
}

/**
 * Le bloc de tête du panneau pour `columns` colonnes et `height` lignes : un titre, puis les décisions dans l'ordre (questions, lots rendus, verdicts UX, livraisons ; l'ordre de `decisionsOf`
 * est gardé), chacune sur une ligne et la commande, repliée, sous les questions et les verdicts (les lignes repliées comptent dans la hauteur). Trop haut : les premières décisions
 * qui tiennent avec la ligne « … +N décisions de plus » (`more` = N).
 * Aucune décision : aucune ligne, le bloc n'occupe rien.
 */
export const buildDecisions = (decisions: readonly Decision[], columns: number, height: number): { lines: DecisionLine[]; more: number } => {
  if (decisions.length === 0) return { lines: [], more: 0 }
  const all = decisions.map(d => linesOf(d, columns))
  const title: DecisionLine = { text: ellipsize(`Ce qui attend une décision (${decisions.length})`, columns), tone: 'title' }
  if (1 + all.reduce((n, l) => n + l.length, 0) <= height) return { lines: [title, ...all.flat()], more: 0 }
  const kept: DecisionLine[][] = []
  let used = 2 // le titre et la ligne « … +N »
  for (const l of all) {
    if (used + l.length > height) break
    kept.push(l)
    used += l.length
  }
  const more = all.length - kept.length
  return { lines: [title, ...kept.flat(), { text: ellipsize(`… +${more} décision${more > 1 ? 's' : ''} de plus`, columns), tone: 'subtle' }], more }
}
