import { expect, test } from 'claude-code/testing'

import { ageLabel, buildDeliveries, deliveriesHeight, deliveriesOf, parseLastDeliveries } from '../hooks/deliveries'
import { parseLotsBoard } from '../hooks/lots'
import type { LastDelivery, LotsBoard } from '../types'

const NOW = new Date(2026, 9, 30, 9, 0).getTime() // 30-10-2026, heure locale
const last = (project: string, extra: Partial<LastDelivery> = {}): LastDelivery => ({ project, day: '2026-10-28', sha: '3f9a1c2d4e5f60718293a4b5c6d7e8f901234567', status: 'verte', green: '2026-10-28', ...extra })
const board = (closed: Record<string, [string, string][]>): LotsBoard => ({ rows: Object.entries(closed).map(([project, c]) => ({ project, lots: [], closed: c.map(([id, finished]) => ({ id, finished })) })), outdated: false })

test('L415 R4 — la dernière livraison d’un projet : sha court (7), âge en jours depuis le jour du journal, verte ou rouge', () => {
  const [row] = deliveriesOf([last('finance')], null, NOW)
  expect(row).toMatchObject({ project: 'finance', sha: '3f9a1c2', age: 2, status: 'verte' })
  expect(deliveriesOf([last('ol', { day: '2026-10-30' })], null, NOW)[0]!.age).toBe(0)
  expect(deliveriesOf([last('ol', { status: 'rouge' })], null, NOW)[0]!.status).toBe('rouge')
})

test('L415 R4 — l’âge : aujourd’hui, hier, « il y a N j » ; un jour dans le futur (horloge) vaut aujourd’hui, jamais un âge négatif', () => {
  expect([0, 1, 2, 45].map(ageLabel)).toEqual(['aujourd’hui', 'hier', 'il y a 2 j', 'il y a 45 j'])
  expect(deliveriesOf([last('ol', { day: '2026-11-02' })], null, NOW)[0]!.age).toBe(0)
})

test('L415 R5 — les lots clos non livrés : clos après le jour de la dernière livraison verte ; clos le jour même ou avant, livré (la règle du délai de livraison de cadence perf)', () => {
  const b = board({ finance: [['L1', '2026-10-27'], ['L2', '2026-10-28'], ['L3', '2026-10-29'], ['L4', '2026-10-30']] })
  expect(deliveriesOf([last('finance')], b, NOW)[0]!.undelivered).toEqual(['L3', 'L4'])
})

test('L415 R5 — une dernière livraison rouge ne livre rien : les lots clos après la dernière VERTE restent non livrés ; sans verte jamais, tous les lots clos le sont', () => {
  const b = board({ finance: [['L1', '2026-10-20'], ['L2', '2026-10-29']], neuf: [['L1', '2026-10-01']] })
  const rows = deliveriesOf([last('finance', { status: 'rouge', day: '2026-10-29', green: '2026-10-25' }), last('neuf', { status: 'rouge', green: null })], b, NOW)
  expect(rows.find(r => r.project === 'finance')!.undelivered).toEqual(['L2'])
  expect(rows.find(r => r.project === 'neuf')!.undelivered).toEqual(['L1'])
})

test('L415 R5 — le plan inconnu n’est pas « rien à livrer » : projet absent du tableau, en erreur, ou cadence ancien (sans closed) → undelivered nul', () => {
  const old = parseLotsBoard(JSON.stringify([{ project: 'ol', lots: [] }]))
  const err: LotsBoard = { rows: [{ project: 'ol', error: 'illisible' }], outdated: false }
  for (const b of [null, board({ autre: [['L1', '2026-10-29']] }), err, old]) expect(deliveriesOf([last('ol')], b, NOW)[0]!.undelivered).toBeNull()
  expect(deliveriesOf([last('ol')], board({ ol: [] }), NOW)[0]!.undelivered).toEqual([])
})

test('L415 R6 — parseLotsBoard garde closed (id, jour) ; une entrée étrangère est sautée, un champ absent reste absent', () => {
  const parsed = parseLotsBoard(JSON.stringify([{ project: 'a', lots: [], closed: [{ id: 'L1', finished: '2026-10-29' }, { id: 3 }, 'x', { id: 'L2', finished: 12 }] }, { project: 'b', lots: [] }]))
  expect(parsed.rows[0]!.closed).toEqual([{ id: 'L1', finished: '2026-10-29' }])
  expect(parsed.rows[1]).not.toHaveProperty('closed')
})

test('L415 R7 — parseLastDeliveries : la sortie du script ; illisible ou étrangère → aucune, une entrée mal formée est sautée', () => {
  expect(parseLastDeliveries(JSON.stringify([last('ol'), { project: 'x' }, last('f', { green: null }), last('g', { status: 'bleue' as 'verte' })]))).toEqual([last('ol'), last('f', { green: null })])
  expect(parseLastDeliveries('pas du json')).toEqual([])
  expect(parseLastDeliveries('{"a":1}')).toEqual([])
})

test('L415 R8 — le bloc : un titre avec le compte, une ligne par projet (sha, âge, verte/rouge, lots clos non livrés), « rien à livrer » quand tout est livré, rien sur les lots quand le plan est inconnu', () => {
  const b = board({ finance: [['L3', '2026-10-29'], ['L4', '2026-10-30']], ol: [['L1', '2026-10-01']] })
  const rows = deliveriesOf([last('finance'), last('ol', { day: '2026-10-30', sha: 'abcdef0123' }), last('wh', { status: 'rouge', day: '2026-10-29' })], b, NOW)
  const { lines } = buildDeliveries(rows, 100, 10)
  expect(lines.map(l => [l.text, l.tone])).toEqual([
    ['Dernière livraison par projet (3)', 'title'],
    ['✖ wh  3f9a1c2 · hier · rouge', 'error'],
    ['✔ finance  3f9a1c2 · il y a 2 j · verte · 2 lots clos non livrés : L3, L4', 'text'],
    ['✔ ol  abcdef0 · aujourd’hui · verte · rien à livrer', 'text'],
  ])
  expect(buildDeliveries(deliveriesOf([last('ol')], null, NOW), 100, 10).lines[1]!.text).toBe('✔ ol  3f9a1c2 · il y a 2 j · verte')
  expect(buildDeliveries(deliveriesOf([last('ol')], board({ ol: [['L1', '2026-10-29']] }), NOW), 100, 10).lines[1]!.text).toBe('✔ ol  3f9a1c2 · il y a 2 j · verte · 1 lot clos non livré : L1')
})

test('L415 R9 — l’ordre : les rouges d’abord, puis le plus de lots clos non livrés, puis le nom ; coupé à la largeur (…)', () => {
  const b = board({ b: [['L1', '2026-10-29']], c: [['L1', '2026-10-29'], ['L2', '2026-10-29']], a: [] })
  const rows = deliveriesOf([last('a'), last('b'), last('c'), last('z', { status: 'rouge' })], b, NOW)
  expect(buildDeliveries(rows, 100, 10).lines.slice(1).map(l => l.text.split('  ')[0])).toEqual(['✖ z', '✔ c', '✔ b', '✔ a'])
  const narrow = buildDeliveries(rows, 30, 10).lines
  expect(narrow.every(l => l.text.length <= 30)).toBe(true)
  expect(narrow[2]!.text.endsWith('…')).toBe(true)
})

test('L415 R10 — rien à montrer : aucune ligne, pas même le titre ; hauteur trop courte : les premiers projets avec « … +N projets », jamais sous deux lignes', () => {
  expect(buildDeliveries([], 100, 10).lines).toEqual([])
  const rows = deliveriesOf([last('a'), last('b'), last('c'), last('d')], null, NOW)
  expect(buildDeliveries(rows, 100, 1).lines).toEqual([])
  expect(buildDeliveries(rows, 100, 2).lines.map(l => l.text)).toEqual(['Dernière livraison par projet (4)', '✔ a  3f9a1c2 · il y a 2 j · verte'])
  expect(buildDeliveries(rows, 100, 4).lines.map(l => l.text)).toEqual(['Dernière livraison par projet (4)', '✔ a  3f9a1c2 · il y a 2 j · verte', '✔ b  3f9a1c2 · il y a 2 j · verte', '… +2 projets'])
})

test('L415 R11 — la hauteur : un projet par ligne et le titre, dans ce que décisions et dépenses laissent de la moitié du corps ; moins de deux lignes → rien', () => {
  expect(deliveriesHeight(0, 40, 0)).toBe(0)
  expect(deliveriesHeight(3, 40, 0)).toBe(4)
  expect(deliveriesHeight(30, 40, 4)).toBe(16)
  expect(deliveriesHeight(3, 40, 19)).toBe(0)
  expect(deliveriesHeight(3, 40, 30)).toBe(0)
})
