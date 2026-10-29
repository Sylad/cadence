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

/**
 * Ce qui attend une décision de la personne, lu dans les vagues de la bande (`waves` : les vivantes, et sans vivante la dernière finie du dossier), dans `ended` (la dernière vague
 * finie du dossier que le collecteur rend à part, qu'une vague vive ou non, L412 : lue sans le délai de 30 min de la bande, une question ou un lot rendu attend tant qu'une autre
 * vague du dossier ne la remplace pas) et dans les livraisons en échec : une question de session (`question`), un lot rendu au lead (`handed-back`, `failed` : la cause est la
 * première ligne de son issue, à défaut son statut), un verdict UX à poser (lot prêt, visible, dont la revue a rendu un verdict) et une livraison en échec par projet.
 * Les vagues vivantes passent d'abord, puis les finies (une vague n'est lue qu'une fois) ; un lot n'est compté que dans la première vague qui le porte ; un lot suspendu n'attend rien de la personne.
 * Le plan tranche (`board`, le tableau du panneau lu de `cadence lead tour --json`) : une décision dont le lot n'est plus ouvert dans un projet que le tour a lu (ligne sans erreur,
 * avec ses lots) n'est plus affichée — un verdict UX posé puis `raf done`, un lot rendu puis repris et clos, une question dont le lot est clos. Un projet absent du tableau, en erreur
 * ou sans lots (cadence trop ancien) garde ses décisions : on ne sait pas. Une livraison en échec ne dépend pas du plan.
 */
export const decisionsOf = (waves: readonly Wave[], deliveries: readonly FailedDelivery[], ended: Wave | null = null, board: LotsBoard | null = null): Decision[] => {
  const open = (project: string, lot: string): boolean => {
    const row = board?.rows.find(r => r.project === project && !r.error && Array.isArray(r.lots))
    return !row || row.lots!.some(t => t.id === lot)
  }
  const finished = [...(ended ? [ended] : []), ...waves.filter(w => !w.live)]
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
        out.push({ kind: 'question', project: l.project, lot: l.lot, text: text || 'question sans texte', command: `cadence orchestrate --resume --wave ${w.id} --answer ${key} "…"` })
      } else if (l.status === 'handed-back' || l.status === 'failed') {
        out.push({ kind: 'rendu', project: l.project, lot: l.lot, text: firstLine(l.outcome ?? '') || lotStatusFr(l.status) })
      } else if (l.status === 'ready' && l.visible === true && typeof l.uxVerdict === 'string' && l.uxVerdict !== '') {
        out.push({ kind: 'ux', project: l.project, lot: l.lot, text: firstLine(l.uxVerdict), command: `raf ux ${l.lot} "verdict"` })
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

/** Les lignes d'une décision : son résumé, puis la commande à copier pour une question ou un verdict UX. */
const linesOf = (d: Decision, columns: number): DecisionLine[] => {
  const where = d.kind === 'livraison' ? d.project : `${d.project}:${d.lot}`
  const label = d.kind === 'livraison' ? 'livraison' : d.kind === 'ux' ? 'verdict UX' : ''
  const head = ellipsize(`${GLYPH[d.kind]} ${where}  ${label ? `${label} : ` : ''}${d.text}`, columns)
  const lines: DecisionLine[] = [{ text: head, tone: d.kind === 'livraison' || d.kind === 'rendu' ? 'error' : 'text' }]
  if (d.kind === 'question' || d.kind === 'ux') lines.push({ text: ellipsize(`   ${d.command}`, columns), tone: 'subtle' })
  return lines
}

/**
 * Le bloc de tête du panneau pour `columns` colonnes et `height` lignes : un titre, puis les décisions dans l'ordre (questions, lots rendus, verdicts UX, livraisons ; l'ordre de `decisionsOf`
 * est gardé), chacune sur une ligne et la commande sous les questions et les verdicts. Trop haut : les premières décisions qui tiennent avec la ligne « … +N décisions de plus » (`more` = N).
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
