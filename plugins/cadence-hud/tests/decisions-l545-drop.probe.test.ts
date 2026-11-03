import { expect, test } from 'claude-code/testing'

import { decisionsOf } from '../hooks/decisions'
import type { Wave, WaveLot } from '../types'

const wlot = (lot: string, status: string, extra: Partial<WaveLot> = {}): WaveLot => ({ project: 'ol', repo: '/p/ol', lot, title: `T ${lot}`, status, pass: 0, model: 'sonnet', next: null, steps: 1, step: null, ...extra })
const wave = (lots: WaveLot[], extra: Partial<Wave> = {}): Wave => ({ id: 'w1', pid: 1, cwd: '/p', started: '2026-10-29T16:00:00Z', live: false, ended: '2026-10-27T12:00:00Z', lots, ...extra })
const D = 'retiré de la vague (--drop)'
const lotsOf = (w: Wave[], ended: Wave[] = []) => decisionsOf(w, [], ended).map(x => (x.kind === 'livraison' ? '' : x.lot))

test('L545 probe — statut failed avec l’issue DROPPED : pas une décision', () => {
  expect(lotsOf([wave([wlot('A', 'failed', { outcome: D })])])).toEqual([])
})

test('L545 probe — issue DROPPED suivie d’une seconde ligne : retiré aussi', () => {
  expect(lotsOf([wave([wlot('A', 'handed-back', { outcome: `${D}\nautre ligne` })])])).toEqual([])
})

test('L545 probe — issue DROPPED précédée d’espaces ou d’un saut de ligne : retiré (le texte affiché est la première ligne rognée)', () => {
  expect(lotsOf([wave([wlot('A', 'handed-back', { outcome: `  ${D}` }), wlot('B', 'handed-back', { outcome: `\n${D}` })])])).toEqual([])
})

test('L545 probe — issue vide, null, absente : le lot rendu reste, avec son statut', () => {
  const d = decisionsOf([wave([wlot('A', 'handed-back', { outcome: '' }), wlot('B', 'handed-back', { outcome: null as unknown as string }), wlot('C', 'failed')])], [])
  expect(d.map(x => (x.kind === 'rendu' ? [x.lot, x.text] : []))).toEqual([['A', 'rendu'], ['B', 'rendu'], ['C', 'échec']])
})

test('L545 probe — issue d’un mauvais type (nombre, objet) : pas d’exception, le lot reste', () => {
  const w = wave([wlot('A', 'handed-back', { outcome: 42 as unknown as string }), wlot('B', 'handed-back', { outcome: {} as unknown as string })])
  expect(() => decisionsOf([w], [])).not.toThrow()
})

test('L545 probe — casse ou variante du préfixe : ce n’est pas un retrait', () => {
  expect(lotsOf([wave([wlot('A', 'handed-back', { outcome: 'Retiré de la vague (--drop)' }), wlot('B', 'handed-back', { outcome: 'retiré de la vague (--drop' })])])).toEqual(['A', 'B'])
})

test('L545 probe — un lot retiré (statut question encore) garde sa question : le statut question n’est pas filtré par l’issue', () => {
  // cycle.ts rend à `handed-back` les questions d’un lot retiré ; un état intermédiaire `question` + issue DROPPED reste affiché
  expect(lotsOf([wave([wlot('A', 'question', { outcome: D, questions: ['q'] })])])).toEqual(['A'])
})

test('L545 probe — retiré dans la vague vivante : masque la décision de la vague finie plus ancienne', () => {
  const live = wave([wlot('B6', 'handed-back', { outcome: D })], { id: 'live', live: true, ended: undefined })
  const old = wave([wlot('B6', 'handed-back', { outcome: 'cause' })], { id: 'old' })
  expect(lotsOf([live], [old])).toEqual([])
})

test('L545 probe — retiré dans la vague ancienne, repris et rendu pour une autre cause dans la plus récente : la décision reste', () => {
  const older = wave([wlot('B6', 'handed-back', { outcome: D })], { id: 'old', ended: '2026-10-26T10:00:00Z' })
  const newer = wave([wlot('B6', 'handed-back', { outcome: 'revue non conforme' })], { id: 'new', ended: '2026-10-27T10:00:00Z' })
  expect(lotsOf([], [newer, older])).toEqual(['B6'])
})

test('L545 probe — même vague passée deux fois (vivante et dans ended) : un retrait ne ressort pas', () => {
  const w = wave([wlot('A', 'handed-back', { outcome: D })])
  expect(lotsOf([w], [w, w])).toEqual([])
})

test('L545 probe — même lot retiré deux fois dans une vague : aucune décision, et les autres lots passent', () => {
  expect(lotsOf([wave([wlot('A', 'handed-back', { outcome: D }), wlot('A', 'handed-back', { outcome: D }), wlot('Z', 'failed')])])).toEqual(['Z'])
})

test('L545 probe — lots de deux projets de même id : le retrait de l’un ne masque pas l’autre', () => {
  const w = wave([wlot('B6', 'handed-back', { outcome: D, project: 'maritime-atlas' }), wlot('B6', 'handed-back', { outcome: 'cause', project: 'ol' })])
  expect(decisionsOf([w], []).map(x => (x.kind === 'rendu' ? x.project : ''))).toEqual(['ol'])
})

test('L545 probe — le retrait ne touche pas les livraisons en échec', () => {
  const d = decisionsOf([wave([wlot('A', 'handed-back', { outcome: D })])], [{ project: 'ol', day: '2026-10-27', sha: 'abc1234', reason: 'CI' }])
  expect(d.map(x => x.kind)).toEqual(['livraison'])
})
