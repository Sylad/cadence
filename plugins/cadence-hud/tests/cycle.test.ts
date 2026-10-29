import { expect, test } from 'claude-code/testing'

import { cycleOf, cycleSegments, cycleText, MAX_FIX } from '../hooks/cycle'
import type { CycleInput } from '../hooks/cycle'
import { buildPanel, waveLotsOf } from '../hooks/lots'
import type { PanelLot, PanelWaveLot } from '../hooks/lots'
import type { LotsRow, TourLot, Wave, WaveLot } from '../types'

const T0 = Date.parse('2026-10-29T10:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const NOW = T0 + 60 * 60_000
const step = (kind: string, from: number, to: number | undefined, status = to === undefined ? 'running' : 'ok') => ({ kind, status, started: at(from), ...(to === undefined ? {} : { ended: at(to) }) })
const wave = (over: Partial<CycleInput> = {}): CycleInput => ({ status: 'implementing', pass: 0, next: null, gate: null, trail: [], ...over })
const names = (c: ReturnType<typeof cycleOf>) => c.map(s => `${s.state}:${s.label}`)

test('L413 R1 — les étapes de la vague dans l’ordre fiche, maquette, accept, implement, revue, correction, porte, UX, intégration, prêt ; fiche, maquette et accept ne sont montrées que si le lot les a jouées', () => {
  const c = cycleOf(wave({ trail: [step('implement', 0, 10)], status: 'reviewing', next: 'review' }), undefined, NOW)
  expect(c.map(s => s.label)).toEqual(['implement', 'revue', 'correction', 'porte', 'UX', 'intégration', 'prêt', 'revue posée', 'clos', 'livré'])
  const full = cycleOf(wave({ trail: [step('spec', 0, 5), step('fiche', 5, 6), step('maquette', 6, 8), step('accept', 8, 9), step('implement', 9, 20, 'ok')] }), undefined, NOW)
  expect(full.slice(0, 5).map(s => s.label)).toEqual(['fiche', 'maquette', 'accept', 'implement', 'revue'])
  // spec et fiche sont une seule étape : la fiche ; precheck n’en est pas une
  expect(cycleOf(wave({ trail: [step('precheck', 0, 1), step('spec', 1, 3), step('fiche', 3, 4)] }), undefined, NOW).filter(s => s.label === 'fiche')).toHaveLength(1)
  expect(cycleOf(wave({ trail: [step('precheck', 0, 1)] }), undefined, NOW).map(s => s.label)).not.toContain('fiche')
})

test('L413 R2 — l’étape courante est celle de la session en cours, avec sa durée depuis son départ ; les étapes faites portent la somme de leurs sessions, les suivantes rien', () => {
  const c = cycleOf(wave({ trail: [step('implement', 0, 10), step('review', 10, 14), step('fix', 14, 30), step('review', 30, undefined)], status: 'reviewing', pass: 1 }), undefined, NOW)
  const by = (label: string) => c.find(s => s.label === label)!
  expect(by('implement')).toMatchObject({ state: 'done', duration: 10 * 60_000 })
  expect(by('revue')).toMatchObject({ state: 'current', duration: (4 + 30) * 60_000 })
  expect(by('correction')).toMatchObject({ state: 'done', duration: 16 * 60_000 })
  expect(by('porte').duration).toBeUndefined()
  expect(by('UX').state).toBe('todo')
  // l’étape courante ne se lit pas deux fois : une seule étape en cours
  expect(c.filter(s => s.state === 'current')).toHaveLength(1)
})

test('L413 R3 — la correction montre ses passes n/3 (celles du lot), la revue ses passes quand elle en a joué plusieurs', () => {
  expect(MAX_FIX).toBe(3)
  const c = cycleOf(wave({ pass: 2, status: 'fixing', trail: [step('implement', 0, 10), step('review', 10, 12), step('fix', 12, 20), step('review', 20, 22), step('fix', 22, undefined)] }), undefined, NOW)
  expect(c.find(s => s.label === 'correction')).toMatchObject({ state: 'current', note: '2/3' })
  expect(c.find(s => s.label === 'revue')).toMatchObject({ state: 'done', note: '×2' })
  // sans correction jouée et une revue passée au-delà : « 0/3 », faite
  const clean = cycleOf(wave({ status: 'ready', trail: [step('implement', 0, 10), step('review', 10, 12), step('ux', 12, 15)] }), undefined, NOW)
  expect(clean.find(s => s.label === 'correction')).toMatchObject({ state: 'done', note: '0/3' })
  expect(clean.find(s => s.label === 'revue')!.note).toBeUndefined()
})

test('L413 R4 — la porte du programme (build, tests) est l’étape courante tant qu’elle tourne, sans session ; sa durée part de son départ', () => {
  const c = cycleOf(wave({ gate: { label: 'tests', started: at(50) }, trail: [step('implement', 0, 40, 'ok')], next: 'review' }), undefined, NOW)
  expect(c.find(s => s.label === 'porte')).toMatchObject({ state: 'current', duration: 10 * 60_000, note: 'tests' })
  expect(c.filter(s => s.state === 'current')).toHaveLength(1)
  expect(c.find(s => s.label === 'implement')!.state).toBe('done')
  expect(c.find(s => s.label === 'revue')!.state).toBe('todo')
})

test('L413 R5 — entre deux sessions, l’étape courante est la prochaine du lot (`next`), sans durée ; l’intégration est une étape ; un lot prêt a tout fait jusqu’à « prêt »', () => {
  const waiting = cycleOf(wave({ status: 'queued', next: 'review', trail: [step('implement', 0, 10)] }), undefined, NOW)
  expect(waiting.find(s => s.label === 'revue')).toMatchObject({ state: 'current' })
  expect(waiting.find(s => s.label === 'revue')!.duration).toBeUndefined()
  const integ = cycleOf(wave({ status: 'ready', trail: [step('implement', 0, 10), step('review', 10, 12), step('integrate', 12, 13)] }), undefined, NOW)
  expect(integ.find(s => s.label === 'intégration')).toMatchObject({ state: 'done', duration: 60_000 })
  expect(integ.find(s => s.label === 'prêt')!.state).toBe('done')
  const ready = cycleOf(wave({ status: 'ready', trail: [step('implement', 0, 10), step('review', 10, 12)] }), undefined, NOW)
  expect(names(ready).slice(0, 7)).toEqual(['done:implement', 'done:revue', 'done:correction', 'done:porte', 'done:UX', 'done:intégration', 'done:prêt'])
})

test('L413 R6 — un lot rendu ou en échec marque en erreur la dernière étape jouée ; une question la laisse en cours', () => {
  const trail = [step('implement', 0, 10), step('review', 10, 12), step('fix', 12, 13, 'failed')]
  expect(cycleOf(wave({ status: 'failed', trail }), undefined, NOW).find(s => s.label === 'correction')).toMatchObject({ state: 'failed' })
  expect(cycleOf(wave({ status: 'handed-back', trail }), undefined, NOW).find(s => s.label === 'correction')).toMatchObject({ state: 'failed' })
  expect(cycleOf(wave({ status: 'question', trail: [step('implement', 0, 10)] }), undefined, NOW).find(s => s.label === 'implement')).toMatchObject({ state: 'current' })
})

test('L413 R6 — un lot rendu à l’intégration (`next: integrate`) marque en erreur l’intégration, pas la dernière étape jouée', () => {
  const trail = [step('implement', 0, 10), step('review', 10, 12), step('ux', 12, 15)]
  for (const status of ['handed-back', 'failed']) {
    const c = cycleOf(wave({ status, next: 'integrate', trail }), undefined, NOW)
    expect(c.find(s => s.label === 'intégration')).toMatchObject({ state: 'failed' })
    expect(c.find(s => s.label === 'UX')).toMatchObject({ state: 'done' })
    expect(c.filter(s => s.state === 'failed')).toHaveLength(1)
  }
  const noUx = cycleOf(wave({ status: 'handed-back', next: 'integrate', trail: trail.slice(0, 2) }), undefined, NOW)
  expect(noUx.find(s => s.label === 'revue')).toMatchObject({ state: 'done' })
  expect(noUx.find(s => s.label === 'intégration')).toMatchObject({ state: 'failed' })
})

test('L413 R7 — côté plan, après la vague : revue posée → clos → livré ; la revue posée est faite quand le plan la porte, la première étape du plan non faite est la courante quand la vague est prête', () => {
  const ready = wave({ status: 'ready', trail: [step('implement', 0, 10)] })
  const unreviewed = cycleOf(ready, { reviewed: false }, NOW)
  expect(names(unreviewed).slice(-3)).toEqual(['current:revue posée', 'todo:clos', 'todo:livré'])
  const reviewed = cycleOf(ready, { reviewed: true }, NOW)
  expect(names(reviewed).slice(-3)).toEqual(['done:revue posée', 'current:clos', 'todo:livré'])
  // la vague travaille encore : le plan attend, rien n’y est courant
  const working = cycleOf(wave({ trail: [step('implement', 0, undefined)] }), { reviewed: false }, NOW)
  expect(names(working).slice(-3)).toEqual(['todo:revue posée', 'todo:clos', 'todo:livré'])
  expect(working.filter(s => s.state === 'current')).toHaveLength(1)
})

test('L413 R8 — un lot en cours au plan sans vague n’a la frise du plan que quand sa revue est posée (sans revue, rien ne s’est passé à montrer) ; un lot à faire sans vague n’en a pas', () => {
  expect(cycleOf(undefined, { reviewed: false, doing: true }, NOW)).toEqual([])
  expect(names(cycleOf(undefined, { reviewed: true, doing: true }, NOW))).toEqual(['done:revue posée', 'current:clos', 'todo:livré'])
  expect(cycleOf(undefined, { reviewed: true, doing: false }, NOW)).toEqual([])
  expect(cycleOf(undefined, { reviewed: false, doing: false }, NOW)).toEqual([])
  expect(cycleOf(undefined, undefined, NOW)).toEqual([])
})

test('L413 R9 — entrées au bord : date de départ illisible (pas de durée, pas de NaN), session en cours sans date, vague sans trail, genre de session inconnu ignoré', () => {
  const c = cycleOf(wave({ trail: [{ kind: 'implement', status: 'running', started: 'pas une date' }, { kind: 'zzz', status: 'ok', started: at(0), ended: at(5) }] }), undefined, NOW)
  const impl = c.find(s => s.label === 'implement')!
  expect(impl.state).toBe('current')
  expect(impl.duration).toBeUndefined()
  expect(cycleText(c, 200)).not.toContain('NaN')
  expect(cycleOf({ ...wave(), trail: undefined as never }, undefined, NOW).length).toBeGreaterThan(0)
  // une session terminée avant d’avoir commencé ne donne pas de durée négative
  expect(cycleOf(wave({ trail: [step('implement', 10, 5)] }), undefined, NOW).find(s => s.label === 'implement')!.duration).toBe(0)
})

test('L413 R10 — le texte de la frise : glyphe, nom, passes et durée de chaque étape ; l’étape courante en gras', () => {
  const c = cycleOf(wave({ pass: 1, status: 'fixing', trail: [step('implement', 0, 10), step('review', 10, 14), step('fix', 14, undefined)] }), { reviewed: false }, NOW)
  const text = cycleText(c, 400)
  expect(text).toContain('✔ implement 10 min')
  expect(text).toContain('✔ revue 4 min')
  expect(text).toContain('▶ correction 1/3 46 min')
  expect(text).toContain('○ porte')
  expect(text.endsWith('○ revue posée → ○ clos → ○ livré')).toBe(true)
  const segs = cycleSegments(c, 400)
  expect(segs.find(s => s.text.includes('▶ correction'))).toMatchObject({ bold: true })
  expect(segs.find(s => s.text.includes('✔ implement'))).not.toMatchObject({ bold: true })
})

test('L413 R11 — trop étroite, la frise replie les étapes faites en « ✔ n » et garde l’étape courante entière ; trop étroite encore, elle ne dépasse jamais la largeur', () => {
  const c = cycleOf(wave({ status: 'fixing', pass: 1, trail: [step('implement', 0, 10), step('review', 10, 14), step('fix', 14, undefined)] }), { reviewed: false }, NOW)
  const wide = cycleText(c, 400)
  const narrow = cycleText(c, wide.length - 1)
  expect(narrow.length).toBeLessThan(wide.length)
  expect(narrow).toMatch(/^✔ 2 → ▶ correction 1\/3 46 min/)
  for (const w of [60, 40, 20, 5, 1]) expect(cycleText(c, w).length, `${w} colonnes`).toBeLessThanOrEqual(w)
  expect(cycleText(c, 0)).toBe('')
  // encore trop étroite : les flèches deviennent des espaces, toutes les étapes restent
  const folded = cycleText(c, wide.length - 1)
  const tight = cycleText(c, folded.length - 1)
  expect(tight).not.toContain('→')
  expect(tight).toContain('○ livré')
  expect(tight.length).toBeLessThan(folded.length)
  // une seule étape faite se replie aussi quand c'est elle qui fait tenir la frise
  const one = cycleOf(wave({ status: 'reviewing', trail: [step('implement', 0, 10), step('review', 10, undefined)] }), { reviewed: false }, NOW)
  expect(cycleText(one, cycleText(one, 400).length - 1)).toMatch(/^✔ 1 → ▶ revue /)
  // rien de fait : rien à replier, la frise est coupée à la largeur
  const fresh = cycleOf(wave({ trail: [step('implement', 0, undefined)] }), undefined, NOW)
  expect(cycleText(fresh, 30).length).toBeLessThanOrEqual(30)
})

// ── dans le panneau ────────────────────────────────────────────────────────────────────────────────────────

const lot = (id: string, status: 'todo' | 'doing', extra: Partial<TourLot> = {}): TourLot => ({ id, title: `Titre ${id}`, status, after: [], ...extra })
const rows = (lots: TourLot[]): LotsRow[] => [{ project: 'ol', lots }]
const inWave = (id: string, over: Partial<PanelWaveLot> = {}): PanelWaveLot => ({ project: 'ol', lot: id, status: 'reviewing', pass: 0, next: null, gate: null, trail: [step('implement', 0, 10)], ...over })
const lotLines = (panel: ReturnType<typeof buildPanel>) => panel.lines.filter((l): l is PanelLot => l.kind === 'lot')

test('L413 R12 — dans le panneau, un lot de vague ou tenu en cours par le plan porte sa frise ; un lot à faire sans vague, une sous-tâche et un lot d’un autre projet n’en portent pas', () => {
  const tour = rows([lot('L1', 'doing', { reviewed: true }), lot('L2', 'todo'), lot('L3', 'todo'), lot('L1/1', 'doing', { parent: 'L1' }), lot('L9', 'doing')])
  const panel = buildPanel({ rows: tour, columns: 160, height: 40, waves: [inWave('L2'), { ...inWave('L3'), project: 'autre' }], now: NOW, views: { 'open:ol#L1': true } })
  const by = (id: string) => lotLines(panel).find(l => l.id === id)!
  expect(by('L1').cycle?.map(s => s.text).join(' → ')).toBe('✔ revue posée → ▶ clos → ○ livré')
  expect(by('L2').cycle?.map(s => s.text).join(' → ')).toContain('✔ implement 10 min')
  expect(by('L3').cycle).toBeUndefined()
  expect(by('L1/1').cycle).toBeUndefined()
  // en cours au plan, sans vague ni revue posée : rien à montrer
  expect(by('L9').cycle).toBeUndefined()
})

test('L413 R13 — la ligne de frise prend une ligne de plus dans la hauteur du panneau : la coupe « … +N lots » la compte', () => {
  const tour = rows([lot('L1', 'doing', { reviewed: true }), lot('L2', 'doing', { reviewed: true }), lot('L3', 'doing', { reviewed: true })])
  const tall = (waves: PanelWaveLot[]) => buildPanel({ rows: tour, columns: 120, height: 9, waves, now: NOW })
  // sans vague, chaque lot en cours dont la revue est posée porte la frise du plan : 1 projet + 3 × 2 lignes + le pied et le titre = 9
  expect(lotLines(tall([])).length).toBe(3)
  expect(tall([]).more).toBe(0)
  const cut = buildPanel({ rows: tour, columns: 120, height: 8, waves: [], now: NOW })
  expect(cut.more).toBeGreaterThan(0)
  // la même hauteur sans frise (lots à faire) montre les trois lots
  expect(lotLines(buildPanel({ rows: rows([lot('L1', 'todo'), lot('L2', 'todo'), lot('L3', 'todo')]), columns: 120, height: 8, waves: [], now: NOW })).length).toBe(3)
})

test('L413 R14 — la frise tient dans la largeur du corps moins le retrait du titre', () => {
  const tour = rows([lot('L1', 'doing')])
  for (const columns of [120, 70, 40, 30]) {
    const line = lotLines(buildPanel({ rows: tour, columns, height: 40, waves: [inWave('L1', { trail: [step('implement', 0, 10), step('review', 10, 14), step('fix', 14, undefined)], pass: 1, status: 'fixing' })], now: NOW }))[0]!
    const width = line.cycle!.reduce((n, s) => n + s.sep.length + s.text.length, 0)
    expect(width, `${columns} colonnes`).toBeLessThanOrEqual(columns - line.idWidth - 2)
  }
})

test('L413 R15 — waveLotsOf donne au panneau les pas, la porte, la passe et la prochaine étape du lot ; un lot sans trail (collecteur plus ancien) a une liste vide', () => {
  const w = (trail?: WaveLot['trail']): Wave => ({ id: 'w', pid: 1, cwd: '/p', started: at(0), live: true, lots: [{ project: 'ol', lot: 'L1', title: 't', status: 'fixing', pass: 2, model: 'sonnet', next: 'review', steps: 1, step: null, gate: { label: 'build', started: at(1) }, ...(trail ? { trail } : {}) }] })
  expect(waveLotsOf([w([step('fix', 0, 1)])], NOW)).toEqual([{ project: 'ol', lot: 'L1', status: 'fixing', pass: 2, next: 'review', gate: { label: 'build', started: at(1) }, trail: [step('fix', 0, 1)] }])
  expect(waveLotsOf([w()], NOW)[0]!.trail).toEqual([])
})
