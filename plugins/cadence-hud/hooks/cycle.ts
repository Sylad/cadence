import type { ThemeKey } from 'claude-code'

import { duration } from './format'

// ── L413 : la frise du cycle d'un lot dans le panneau des lots — les étapes de la vague, puis celles du plan ─────────

/** Passes de correction que le panneau montre au plus (« correction 1/3 ») : MAX_PASSES_CONVERGING de src/orchestrate/cycle.ts. */
export const MAX_FIX = 3

/** Les étapes de la vague, dans l'ordre du cycle d'un lot. */
const WAVE_STAGES = ['fiche', 'maquette', 'accept', 'implement', 'revue', 'correction', 'porte', 'UX', 'intégration', 'prêt'] as const
/** Les étapes que seul un lot à écran ou à fiche joue : la frise ne les montre que jouées. */
const OPTIONAL = new Set<string>(['fiche', 'maquette', 'accept'])
/** Les étapes du plan, après la vague : la revue de code posée au plan, le lot clos, le lot livré. */
const PLAN_STAGES = ['revue posée', 'clos', 'livré'] as const

/** L'étape d'un genre de session ou de pas de la vague ; le contrôle préalable (`precheck`) et les genres inconnus n'en sont pas une. */
const STAGE_OF: Record<string, (typeof WAVE_STAGES)[number]> = {
  spec: 'fiche', fiche: 'fiche', maquette: 'maquette', accept: 'accept', implement: 'implement', review: 'revue', 'review-small': 'revue', fix: 'correction', ux: 'UX', integrate: 'intégration',
}

/** Un pas de l'état du lot (`steps[]` de son JSON) tel que le collecteur le rend. */
export type TrailStep = { kind: string; status: string; started: string; ended?: string }

/** Ce que la frise lit d'un lot de vague. */
export type CycleInput = {
  status: string
  /** Passes de correction faites ; absent, aucune. */
  pass?: number
  /** La prochaine étape à jouer (`next` de l'état du lot). */
  next?: string | null
  gate?: { label: string; started: string } | null
  trail?: readonly TrailStep[]
}

/** Ce que la frise lit du plan pour ce lot. */
export type PlanInput = { reviewed: boolean; /** le plan le tient `doing` */ doing?: boolean }

export type Stage = {
  label: string
  state: 'done' | 'current' | 'todo' | 'failed'
  /** Durée en ms : somme des sessions de l'étape, jusqu'à maintenant pour celle qui tourne ; absente d'une étape non jouée ou sans date lisible. */
  duration?: number
  /** Passes (« 1/3 » de la correction, « ×2 » d'une revue rejouée) ou nature de la porte (« tests »). */
  note?: string
}

const ms = (iso: string | undefined): number => (iso === undefined ? NaN : Date.parse(iso))

/** Les étapes de la vague d'un lot. */
const waveStages = (lot: CycleInput, now: number): Stage[] => {
  const trail = Array.isArray(lot.trail) ? lot.trail : []
  const known = trail.filter(t => STAGE_OF[t.kind] !== undefined)
  const steps = (label: string) => known.filter(t => STAGE_OF[t.kind] === label)
  const index = (label: string) => WAVE_STAGES.indexOf(label as (typeof WAVE_STAGES)[number])
  const lastPlayed = known.length > 0 ? STAGE_OF[known[known.length - 1]!.kind]! : undefined
  const running = [...known].reverse().find(t => t.status === 'running')
  const gating = !running && !!lot.gate
  const ready = lot.status === 'ready'
  // l'étape courante : la session qui tourne, la porte, sinon (entre deux sessions) la prochaine du lot ; un lot rendu ou en échec garde sa dernière étape, en erreur
  let current: string | undefined
  let failed: string | undefined
  if (running) current = STAGE_OF[running.kind]
  else if (gating) current = 'porte'
  else if (lot.status === 'failed' || lot.status === 'handed-back') failed = lastPlayed
  else if (lot.status === 'question') current = lastPlayed
  else if (!ready && lot.next) current = STAGE_OF[lot.next]
  // l'étape la plus avancée jouée ; la porte n'en fait pas partie (elle passe entre l'écriture et la revue sans pas à elle)
  const furthest = Math.max(ready ? index('prêt') : -1, ...known.map(t => index(STAGE_OF[t.kind]!)))
  const out: Stage[] = []
  for (const label of WAVE_STAGES) {
    const played = steps(label)
    if (OPTIONAL.has(label) && played.length === 0 && current !== label) continue
    let state: Stage['state'] = 'todo'
    if (label === failed) state = 'failed'
    else if (label === current) state = 'current'
    else if (played.length > 0 || index(label) < furthest || (label === 'prêt' && ready)) state = 'done'
    const stage: Stage = { label, state }
    if (played.length > 0 || label === current) {
      const sums = played.map(t => (t.status === 'running' ? now : ms(t.ended)) - ms(t.started)).filter(Number.isFinite)
      if (label === 'porte' && gating) {
        const since = ms(lot.gate!.started)
        if (Number.isFinite(since)) stage.duration = Math.max(0, now - since)
      } else if (sums.length > 0 && sums.length === played.length) {
        stage.duration = sums.reduce((n, d) => n + Math.max(0, d), 0)
      }
    }
    if (label === 'correction') stage.note = `${lot.pass ?? 0}/${MAX_FIX}`
    else if (label === 'revue' && played.length > 1) stage.note = `×${played.length}`
    else if (label === 'porte' && gating) stage.note = lot.gate!.label
    out.push(stage)
  }
  return out
}

/** Les étapes du plan d'un lot ; la première non faite est la courante quand `active` (la vague n'a plus rien en cours). */
const planStages = (plan: PlanInput, active: boolean): Stage[] => {
  const out: Stage[] = PLAN_STAGES.map((label, i) => ({ label, state: i === 0 && plan.reviewed ? 'done' : 'todo' }))
  const first = out.find(s => s.state !== 'done')
  if (active && first) first.state = 'current'
  return out
}

/**
 * La frise d'un lot : ses étapes de vague s'il en a une (`lot`), puis celles du plan (revue posée → clos → livré). Sans vague, un lot que le plan tient en cours n'a que celles du plan, et seulement
 * une fois sa revue posée (avant, rien ne s'est passé qu'une frise puisse montrer) ; un lot à faire sans vague, ou sans lecture du plan, n'a rien (`[]`). Les durées sont calculées à `now` (ms).
 */
export const cycleOf = (lot: CycleInput | undefined, plan: PlanInput | undefined, now: number): Stage[] => {
  if (!lot) return plan?.doing && plan.reviewed ? planStages(plan, true) : []
  const wave = waveStages(lot, now)
  return [...wave, ...planStages(plan ?? { reviewed: false }, !wave.some(s => s.state === 'current') && !wave.some(s => s.state === 'failed') && lot.status === 'ready')]
}

const GLYPH: Record<Stage['state'], string> = { done: '✔', current: '▶', todo: '○', failed: '✖' }
const COLOR: Record<Stage['state'], ThemeKey> = { done: 'success', current: 'claude', todo: 'subtle', failed: 'error' }

/** Une étape en texte : « ▶ correction 1/3 46 min ». */
const stageText = (s: Stage): string => [GLYPH[s.state], s.label, s.note, s.duration === undefined ? undefined : duration(s.duration)].filter(Boolean).join(' ')

/** Un segment de la frise : `sep`, ce qui le sépare du précédent (vide au premier). */
export type CycleSeg = { text: string; color: ThemeKey; bold?: boolean; sep: string }

const SEP = ' → '
/** Le séparateur de la frise serrée, quand même repliée elle ne tient pas. */
const TIGHT = ' '

/** Coupe à `max` caractères avec « … » (jamais plus long). */
const cut = (text: string, max: number): string => (max <= 0 ? '' : text.length <= max ? text : max === 1 ? '…' : `${text.slice(0, max - 1)}…`)

/**
 * La frise en segments colorés pour `width` colonnes. Trop longue, par degrés : les étapes faites du début se replient en « ✔ n » (l'étape courante, la rendue et les à venir restent entières),
 * puis les flèches deviennent de simples espaces ; trop longue encore, la fin est coupée par « … ». Jamais plus large que `width`.
 */
export const cycleSegments = (stages: readonly Stage[], width: number): CycleSeg[] => {
  if (width <= 0 || stages.length === 0) return []
  const seg = (s: Stage): Omit<CycleSeg, 'sep'> => ({ text: stageText(s), color: COLOR[s.state], ...(s.state === 'current' ? { bold: true } : {}) })
  const full = stages.map(seg)
  const lead = stages.findIndex(s => s.state !== 'done')
  const folded = lead < 0 ? stages.length : lead
  const fold = folded >= 1 ? [{ text: `✔ ${folded}`, color: COLOR.done }, ...full.slice(folded)] : full
  const size = (segs: readonly { text: string }[], gap: string) => segs.reduce((n, s) => n + s.text.length, 0) + gap.length * Math.max(0, segs.length - 1)
  let segs = full
  let sep = SEP
  if (size(segs, sep) > width) segs = fold
  if (size(segs, sep) > width) sep = TIGHT
  // coupe : les segments entiers qui tiennent, puis le suivant tronqué
  const out: CycleSeg[] = []
  let used = 0
  for (const s of segs) {
    const gap = out.length > 0 ? sep : ''
    const room = width - used - gap.length
    if (room <= 0) break
    const text = cut(s.text, room)
    out.push({ ...s, text, sep: gap })
    used += gap.length + text.length
    if (text.length < s.text.length) break
  }
  return out
}

/** La frise en une chaîne, ses segments avec leurs séparateurs. */
export const cycleText = (stages: readonly Stage[], width: number): string => cycleSegments(stages, width).map(s => s.sep + s.text).join('')
