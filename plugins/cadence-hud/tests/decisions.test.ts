import { expect, test } from 'claude-code/testing'

import { buildDecisions, decisionsOf, parseDeliveries, wrapCommand } from '../hooks/decisions'
import type { FailedDelivery, LotsBoard, TourLot, Wave, WaveLot } from '../types'

const wlot = (lot: string, status: string, extra: Partial<WaveLot> = {}): WaveLot => ({ project: 'ol', lot, title: `T ${lot}`, status, pass: 0, model: 'sonnet', next: null, steps: 1, step: null, ...extra })
const wave = (lots: WaveLot[], extra: Partial<Wave> = {}): Wave => ({ id: 'w1', pid: 1, cwd: '/p', started: '2026-10-29T16:00:00Z', live: true, lots, ...extra })

test('L412 R1 — une question de session : le texte court et la commande --answer de la vague', () => {
  const d = decisionsOf([wave([wlot('L5', 'question', { questions: ['Quel format ?', 'Quelle date ?'] })])], [])
  expect(d).toEqual([{ kind: 'question', project: 'ol', lot: 'L5', text: 'Quel format ? / Quelle date ?', command: 'cadence orchestrate --resume --wave w1 --answer ol:L5 "…"' }])
})

test('L412 R2 — un lot rendu au lead : la cause en une ligne (première ligne de l’issue), à défaut le statut', () => {
  const d = decisionsOf([wave([wlot('L1', 'handed-back', { outcome: 'revue non conforme après 3 passes\nsuite' }), wlot('L2', 'failed'), wlot('L3', 'suspended', { outcome: 'quota' })])], [])
  expect(d.map(x => [x.kind, x.kind === 'livraison' ? '' : x.lot, x.kind === 'rendu' ? x.text : ''])).toEqual([['rendu', 'L1', 'revue non conforme après 3 passes'], ['rendu', 'L2', 'échec']])
})

test('L412 R3 — un verdict UX à poser : lot prêt, visible, verdict de la revue lu, avec raf ux', () => {
  const d = decisionsOf([wave([wlot('L1', 'ready', { visible: true, uxVerdict: 'conforme' }), wlot('L2', 'ready', { visible: false, uxVerdict: 'conforme' }), wlot('L3', 'ready', { visible: true, uxVerdict: null }), wlot('L4', 'reviewing', { visible: true, uxVerdict: 'x' })])], [])
  expect(d).toEqual([{ kind: 'ux', project: 'ol', lot: 'L1', text: 'conforme', command: 'raf ux L1 "verdict"' }])
})

test('L412 R4 — une livraison en échec par projet : la dernière raison et le sha', () => {
  const failed: FailedDelivery[] = [{ project: 'maritime', day: '2026-10-29', sha: 'abc1234', reason: 'CI en échec' }]
  expect(decisionsOf([], failed)).toEqual([{ kind: 'livraison', project: 'maritime', text: 'abc1234 · CI en échec (2026-10-29)' }])
})

test('L412 R5 — la vague finie se lit dans `ended` (sans délai de 30 min, à part de la bande), après les vivantes ; un lot n’est compté qu’une fois ; sans vivante, celle que porte `waves` se lit aussi', () => {
  const old = wave([wlot('L9', 'question', { questions: ['q'] }), wlot('L8', 'handed-back', { outcome: 'cause' })], { id: 'old', live: false, ended: '2026-10-29T10:00:00Z' })
  const lots = (d: ReturnType<typeof decisionsOf>) => d.map(x => (x.kind === 'livraison' ? '' : x.lot))
  expect(lots(decisionsOf([], [], old))).toEqual(['L9', 'L8'])
  expect(lots(decisionsOf([old], []))).toEqual(['L9', 'L8']) // sans vague vivante, la bande porte la vague finie
  expect(lots(decisionsOf([old], [], old))).toEqual(['L9', 'L8']) // la même vague des deux côtés : une fois
  const recent = wave([wlot('L5', 'question', { questions: ['ancienne'] })], { id: 'rec', live: false, ended: '2026-10-29T16:50:00Z' })
  const live = wave([wlot('L5', 'question', { questions: ['vivante'] })], { id: 'liv' })
  const d = decisionsOf([live], [], recent)
  expect(d).toHaveLength(1)
  expect(d[0]).toMatchObject({ text: 'vivante' })
})

test('L412 R6 — rien à décider : aucune décision, aucune ligne', () => {
  expect(decisionsOf([wave([wlot('L1', 'reviewing')])], [])).toEqual([])
  expect(buildDecisions([], 60, 10)).toEqual({ lines: [], more: 0 })
})

test('L412 R7 — une question sans texte, ou aux types faux, reste une question (texte vide dit « question sans texte »)', () => {
  const d = decisionsOf([wave([wlot('L5', 'question', { questions: [] }), wlot('L6', 'question', { questions: undefined })])], [])
  expect(d.map(x => (x.kind === 'question' ? x.text : ''))).toEqual(['question sans texte', 'question sans texte'])
})

test('L412 R8 — le panneau coupe les textes à la largeur et compte les décisions qu’il ne montre pas', () => {
  const many = Array.from({ length: 6 }, (_, i) => wlot(`L${i}`, 'handed-back', { outcome: 'x'.repeat(100) }))
  const built = buildDecisions(decisionsOf([wave(many)], []), 40, 4)
  expect(built.lines.every(l => l.text.length <= 40)).toBe(true)
  expect(built.lines.length).toBe(4)
  expect(built.more).toBe(4)
  expect(built.lines[3]!.text).toMatch(/\+4 décisions/)
})

test('L412 R9 — les lignes : un titre, puis une ligne par décision, la commande à copier sous une question ou un verdict', () => {
  const d = decisionsOf([wave([wlot('L5', 'question', { questions: ['Quel format ?'] })])], [])
  const { lines } = buildDecisions(d, 120, 10)
  expect(lines[0]!.text).toMatch(/Ce qui attend une décision/)
  expect(lines[1]!.text).toMatch(/ol:L5.*Quel format \?/)
  expect(lines[2]!.text).toMatch(/cadence orchestrate --resume --wave w1 --answer ol:L5 "…"/)
})

test('L412 R10 — journal des livraisons : lu de la sortie du script, une sortie étrangère ou illisible ne donne rien', () => {
  expect(parseDeliveries('[{"project":"a","day":"2026-10-29","sha":"s","reason":"r"},{"project":3},"x"]')).toEqual([{ project: 'a', day: '2026-10-29', sha: 's', reason: 'r' }])
  expect(parseDeliveries('{"waves":[]}')).toEqual([])
  expect(parseDeliveries('pas du json')).toEqual([])
})

const tlot = (id: string): TourLot => ({ id, title: `T ${id}`, status: 'todo', after: [] })

test('L412 R21 — le plan tranche : une décision dont le lot n’est plus ouvert dans un projet lu du tableau disparaît ; un projet absent du tableau, en erreur ou sans lots garde les siennes', () => {
  const w = wave([
    wlot('L1', 'ready', { visible: true, uxVerdict: 'conforme' }), // clos au plan (raf ux puis raf done) : plus rien à poser
    wlot('L2', 'handed-back', { outcome: 'cause' }), // encore ouvert : attend
    wlot('L3', 'question', { questions: ['q'] }), // clos au plan : la question n'a plus d'objet
    wlot('L4', 'question', { questions: ['q'], project: 'maritime' }), // projet absent du tableau : on ne sait pas, elle reste
    wlot('L5', 'handed-back', { project: 'erreur' }), // projet illisible par le tour : reste
    wlot('L6', 'handed-back', { project: 'ancien' }), // ligne sans lots (cadence trop ancien) : reste
  ])
  const board: LotsBoard = { outdated: false, rows: [{ project: 'ol', lots: [tlot('L2'), tlot('L9/1')] }, { project: 'erreur', error: 'plan illisible' }, { project: 'ancien' }] }
  const lots = (d: ReturnType<typeof decisionsOf>) => d.map(x => (x.kind === 'livraison' ? '' : x.lot))
  expect(lots(decisionsOf([w], [], null, board))).toEqual(['L2', 'L4', 'L5', 'L6'])
  expect(lots(decisionsOf([w], [], null, null))).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']) // sans tableau lu, rien n'est écarté
  // une sous-tâche ouverte se reconnaît par son id complet ; une livraison en échec ne dépend pas du plan
  const sub = wave([wlot('L9/1', 'question', { questions: ['q'] }), wlot('L9/2', 'question', { questions: ['q'] })])
  const failed: FailedDelivery[] = [{ project: 'ol', day: '2026-10-29', sha: 'abc1234', reason: 'CI en échec' }]
  expect(decisionsOf([sub], failed, null, board).map(x => (x.kind === 'livraison' ? x.kind : x.lot))).toEqual(['L9/1', 'livraison'])
})

test('L412 R22 — la commande à copier se replie sur plusieurs lignes à la largeur, aux espaces, jamais coupée par « … » ; le plafond du bloc compte les lignes repliées', () => {
  const q = wave([wlot('Q4/accueil-4-ux12', 'question', { questions: ['Quel titre ?'], project: 'maritime-atlas' })], { id: '2026-10-29-1650' })
  const command = 'cadence orchestrate --resume --wave 2026-10-29-1650 --answer maritime-atlas:Q4/accueil-4-ux12 "…"'
  const { lines } = buildDecisions(decisionsOf([q], []), 70, 20)
  const cmd = lines.slice(2)
  expect(cmd.length).toBeGreaterThan(1)
  expect(cmd.every(l => l.text.length <= 70 && l.tone === 'subtle' && l.text.startsWith('   '))).toBe(true)
  expect(cmd.map(l => l.text.trim()).join(' ')).toBe(command) // recopiable : rien de perdu
  expect(cmd.map(l => l.text)).toEqual(['   cadence orchestrate --resume --wave 2026-10-29-1650 --answer', '   maritime-atlas:Q4/accueil-4-ux12 "…"'])
  // le plafond compte le titre, la ligne de la question et ses 2 lignes de commande : 4 lignes
  expect(buildDecisions(decisionsOf([q], []), 70, 4)).toMatchObject({ more: 0 })
  expect(buildDecisions(decisionsOf([q], []), 70, 4).lines).toHaveLength(4)
  const short = buildDecisions(decisionsOf([q], []), 70, 3)
  expect(short.more).toBe(1)
  expect(short.lines.map(l => l.text)).toEqual(['Ce qui attend une décision (1)', '… +1 décision de plus'])
  // large : une seule ligne ; un mot plus long que la ligne est coupé sans « … » ; une largeur nulle ne donne rien de plus long qu'elle
  expect(wrapCommand(command, 120)).toEqual([`   ${command}`])
  expect(wrapCommand('a bbbbbbbbbb c', 9)).toEqual(['   a', '   bbbbbb', '   bbbb c'])
  expect(wrapCommand('raf ux L1 "verdict"', 1).every(l => l.length <= 1)).toBe(true)
})
