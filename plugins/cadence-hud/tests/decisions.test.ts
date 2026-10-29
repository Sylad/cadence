import { expect, test } from 'claude-code/testing'

import { buildDecisions, decisionsOf, parseDeliveries } from '../hooks/decisions'
import type { FailedDelivery, Wave, WaveLot } from '../types'

const AT = Date.parse('2026-10-29T17:00:00Z')
const wlot = (lot: string, status: string, extra: Partial<WaveLot> = {}): WaveLot => ({ project: 'ol', lot, title: `T ${lot}`, status, pass: 0, model: 'sonnet', next: null, steps: 1, step: null, ...extra })
const wave = (lots: WaveLot[], extra: Partial<Wave> = {}): Wave => ({ id: 'w1', pid: 1, cwd: '/p', started: '2026-10-29T16:00:00Z', live: true, lots, ...extra })

test('R1 — une question de session : le texte court et la commande --answer de la vague', () => {
  const d = decisionsOf([wave([wlot('L5', 'question', { questions: ['Quel format ?', 'Quelle date ?'] })])], AT, [])
  expect(d).toEqual([{ kind: 'question', project: 'ol', lot: 'L5', text: 'Quel format ? / Quelle date ?', command: 'cadence orchestrate --resume --wave w1 --answer ol:L5 "…"' }])
})

test('R2 — un lot rendu au lead : la cause en une ligne (première ligne de l’issue), à défaut le statut', () => {
  const d = decisionsOf([wave([wlot('L1', 'handed-back', { outcome: 'revue non conforme après 3 passes\nsuite' }), wlot('L2', 'failed'), wlot('L3', 'suspended', { outcome: 'quota' })])], AT, [])
  expect(d.map(x => [x.kind, x.kind === 'livraison' ? '' : x.lot, x.kind === 'rendu' ? x.text : ''])).toEqual([['rendu', 'L1', 'revue non conforme après 3 passes'], ['rendu', 'L2', 'échec']])
})

test('R3 — un verdict UX à poser : lot prêt, visible, verdict de la revue lu, avec raf ux', () => {
  const d = decisionsOf([wave([wlot('L1', 'ready', { visible: true, uxVerdict: 'conforme' }), wlot('L2', 'ready', { visible: false, uxVerdict: 'conforme' }), wlot('L3', 'ready', { visible: true, uxVerdict: null }), wlot('L4', 'reviewing', { visible: true, uxVerdict: 'x' })])], AT, [])
  expect(d).toEqual([{ kind: 'ux', project: 'ol', lot: 'L1', text: 'conforme', command: 'raf ux L1 "verdict"' }])
})

test('R4 — une livraison en échec par projet : la dernière raison et le sha', () => {
  const failed: FailedDelivery[] = [{ project: 'maritime', day: '2026-10-29', sha: 'abc1234', reason: 'CI en échec' }]
  expect(decisionsOf([], AT, failed)).toEqual([{ kind: 'livraison', project: 'maritime', text: 'abc1234 · CI en échec (2026-10-29)' }])
})

test('R5 — une vague terminée depuis plus de 30 min n’est plus lue ; une vague vivante passe avant, et un lot n’est compté qu’une fois', () => {
  const old = wave([wlot('L9', 'question', { questions: ['q'] })], { id: 'old', live: false, ended: '2026-10-29T16:00:00Z' })
  expect(decisionsOf([old], AT, [])).toEqual([])
  const recent = wave([wlot('L5', 'question', { questions: ['ancienne'] })], { id: 'rec', live: false, ended: '2026-10-29T16:50:00Z' })
  const live = wave([wlot('L5', 'question', { questions: ['vivante'] })], { id: 'liv' })
  const d = decisionsOf([recent, live], AT, [])
  expect(d).toHaveLength(1)
  expect(d[0]).toMatchObject({ text: 'vivante' })
})

test('R6 — rien à décider : aucune décision, aucune ligne', () => {
  expect(decisionsOf([wave([wlot('L1', 'reviewing')])], AT, [])).toEqual([])
  expect(buildDecisions([], 60, 10)).toEqual({ lines: [], more: 0 })
})

test('R7 — une question sans texte, ou aux types faux, reste une question (texte vide dit « question sans texte »)', () => {
  const d = decisionsOf([wave([wlot('L5', 'question', { questions: [] }), wlot('L6', 'question', { questions: undefined })])], AT, [])
  expect(d.map(x => (x.kind === 'question' ? x.text : ''))).toEqual(['question sans texte', 'question sans texte'])
})

test('R8 — le panneau coupe les textes à la largeur et compte les décisions qu’il ne montre pas', () => {
  const many = Array.from({ length: 6 }, (_, i) => wlot(`L${i}`, 'handed-back', { outcome: 'x'.repeat(100) }))
  const built = buildDecisions(decisionsOf([wave(many)], AT, []), 40, 4)
  expect(built.lines.every(l => l.text.length <= 40)).toBe(true)
  expect(built.lines.length).toBe(4)
  expect(built.more).toBe(4)
  expect(built.lines[3]!.text).toMatch(/\+4 décisions/)
})

test('R9 — les lignes : un titre, puis une ligne par décision, la commande à copier sous une question ou un verdict', () => {
  const d = decisionsOf([wave([wlot('L5', 'question', { questions: ['Quel format ?'] })])], AT, [])
  const { lines } = buildDecisions(d, 120, 10)
  expect(lines[0]!.text).toMatch(/Ce qui attend une décision/)
  expect(lines[1]!.text).toMatch(/ol:L5.*Quel format \?/)
  expect(lines[2]!.text).toMatch(/cadence orchestrate --resume --wave w1 --answer ol:L5 "…"/)
})

test('R10 — journal des livraisons : lu de la sortie du script, une sortie étrangère ou illisible ne donne rien', () => {
  expect(parseDeliveries('[{"project":"a","day":"2026-10-29","sha":"s","reason":"r"},{"project":3},"x"]')).toEqual([{ project: 'a', day: '2026-10-29', sha: 's', reason: 'r' }])
  expect(parseDeliveries('{"waves":[]}')).toEqual([])
  expect(parseDeliveries('pas du json')).toEqual([])
})
