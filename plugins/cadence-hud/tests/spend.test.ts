import { expect, test } from 'claude-code/testing'

import { buildSpend, parseTypical, spendOf } from '../hooks/spend'
import type { Wave, WaveLot } from '../types'

const NOW = Date.parse('2026-10-29T20:00:00.000Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
const wlot = (lot: string, extra: Partial<WaveLot> = {}): WaveLot => ({ project: 'cadence', repo: '/p/cadence', lot, title: `T ${lot}`, status: 'implementing', pass: 0, model: 'sonnet', next: null, steps: 1, step: null, budget: 750_000, consumed: 100_000, estimate: 0.5, since: minutesAgo(10), until: null, ...extra })
const wave = (lots: WaveLot[], extra: Partial<Wave> = {}): Wave => ({ id: 'w1', pid: 1, cwd: '/p', started: '2026-10-29T16:00:00Z', live: true, lots, ...extra })
const TYPICAL = { '0.5': 30, '1': 60, '0.5+spec': 90 }

test('L414 R1 — un lot en cours sous son budget et sous son temps habituel : tokens sur budget, temps écoulé et temps habituel, sans signal', () => {
  const rows = spendOf([wave([wlot('L414')])], TYPICAL, NOW)
  expect(rows).toEqual([{ project: 'cadence', lot: 'L414', consumed: 100_000, budget: 750_000, minutes: 10, usual: 30, tokensOver: false, timeOver: false }])
  const { lines } = buildSpend(rows, 100, 10)
  expect(lines.map(l => [l.text, l.tone])).toEqual([
    ['Lots en cours : budget et durée (1)', 'title'],
    ['▶ cadence:L414  100k/750k tokens · 10 min (habituel 30 min)', 'text'],
  ])
})

test('L414 R2 — le lot qui dépasse son budget de tokens porte le signal : ⚠, « dépassé » après les tokens, couleur d’avertissement (L64 : 786k sur 750k, 53 min)', () => {
  const rows = spendOf([wave([wlot('L64', { consumed: 786_000, since: minutesAgo(53) })])], { '0.5': 60 }, NOW)
  expect(rows[0]).toMatchObject({ tokensOver: true, timeOver: false, minutes: 53 })
  expect(buildSpend(rows, 100, 10).lines[1]).toEqual({ text: '⚠ cadence:L64  786k/750k tokens dépassé · 53 min (habituel 1 h 00)', tone: 'warning' })
})

test('L414 R3 — le lot plus long que le temps habituel d’un lot de sa taille (au-delà d’une fois et demie) porte le signal, pas avant', () => {
  const at = (minutes: number) => spendOf([wave([wlot('L1', { since: minutesAgo(minutes) })])], { '0.5': 30 }, NOW)[0]!
  expect(at(45).timeOver).toBe(false)
  expect(at(46).timeOver).toBe(true)
  expect(buildSpend([at(46)], 100, 10).lines[1]).toEqual({ text: '⚠ cadence:L1  100k/750k tokens · 46 min (habituel 30 min, dépassé)', tone: 'warning' })
})

test('L414 R4 — le budget d’un lot sans escalade engagée ne compte pas la part réservée à l’escalade ; escalade engagée, elle est libérée et compte', () => {
  const lots = [wlot('L1', { budget: 775_000, escalationReserve: 175_000, consumed: 650_000 }), wlot('L2', { budget: 775_000, escalationReserve: 175_000, escalated: true, consumed: 650_000 }), wlot('L3', { budget: 775_000, escalationReserve: 175_000, consumed: 590_000 })]
  const rows = spendOf([wave(lots)], TYPICAL, NOW)
  expect(rows.map(r => [r.lot, r.budget, r.tokensOver])).toEqual([['L1', 600_000, true], ['L2', 775_000, false], ['L3', 600_000, false]])
})

test('L414 R5 — la classe de taille suit celle de cadence perf : estimate, « +spec » pour un lot de la chaîne spec ; sans temps habituel pour sa classe (ou sans estimate), la durée seule, jamais de signal de temps', () => {
  const rows = spendOf([wave([wlot('L1', { estimate: 1 }), wlot('L2', { spec: true, since: minutesAgo(200) }), wlot('L3', { estimate: 2, since: minutesAgo(500) }), wlot('L4', { estimate: undefined, since: minutesAgo(500) })])], TYPICAL, NOW)
  expect(rows.map(r => [r.lot, r.usual, r.timeOver])).toEqual([['L1', 60, false], ['L2', 90, true], ['L3', null, false], ['L4', null, false]])
  expect(buildSpend([rows[2]!], 100, 10).lines[1]!.text).toBe('▶ cadence:L3  100k/750k tokens · 8 h 20')
})

test('L414 R6 — un lot sans budget dans son état : les tokens consommés seuls, jamais dépassés', () => {
  const rows = spendOf([wave([wlot('L1', { budget: undefined, consumed: 900_000 })])], TYPICAL, NOW)
  expect(rows[0]).toMatchObject({ budget: null, tokensOver: false })
  expect(buildSpend(rows, 100, 10).lines[1]!.text).toBe('▶ cadence:L1  900k tokens · 10 min (habituel 30 min)')
})

test('L414 R7 — seuls les lots travaillés d’une vague VIVANTE comptent : ni lot prêt, rendu, en attente ou suspendu, ni vague finie ; la durée d’un lot dont la dernière étape est finie s’arrête à sa fin', () => {
  const lots = [wlot('L1'), wlot('L2', { status: 'reviewing' }), wlot('L3', { status: 'fixing' }), wlot('L4', { status: 'ready' }), wlot('L5', { status: 'handed-back' }), wlot('L6', { status: 'queued' }), wlot('L7', { status: 'suspended' }), wlot('L8', { status: 'question', since: minutesAgo(20), until: minutesAgo(15) })]
  const rows = spendOf([wave(lots), wave([wlot('L9')], { id: 'w0', live: false })], TYPICAL, NOW)
  expect(rows.map(r => r.lot)).toEqual(['L1', 'L2', 'L3', 'L8'])
  expect(rows.find(r => r.lot === 'L8')!.minutes).toBe(5)
})

test('L414 R8 — un lot sans début lisible ou sans tokens lus : ligne sans durée ou à zéro token, jamais NaN', () => {
  const rows = spendOf([wave([wlot('L1', { since: null }), wlot('L2', { consumed: undefined }), wlot('L3', { since: 'pas une date' })])], TYPICAL, NOW)
  expect(rows.map(r => [r.minutes, r.consumed, r.timeOver])).toEqual([[null, 100_000, false], [10, 0, false], [null, 100_000, false]])
  expect(buildSpend([rows[0]!], 100, 10).lines[1]!.text).toBe('▶ cadence:L1  100k/750k tokens')
})

test('L414 R9 — rien en cours : aucune ligne, pas même le titre ; la liste est coupée à la hauteur donnée avec le compte des lots cachés, les lots en dépassement d’abord', () => {
  expect(buildSpend([], 100, 10).lines).toEqual([])
  const rows = spendOf([wave([wlot('L1'), wlot('L2'), wlot('L3', { consumed: 800_000 }), wlot('L4')])], TYPICAL, NOW)
  const { lines } = buildSpend(rows, 100, 3)
  expect(lines.map(l => l.text)).toEqual(['Lots en cours : budget et durée (4)', '⚠ cadence:L3  800k/750k tokens dépassé · 10 min (habituel 30 min)', '… +3 lots en cours'])
  expect(buildSpend(rows, 100, 0).lines).toEqual([])
})

test('L414 R10 — le temps habituel vient de `cadence perf --json` : la médiane de la fenêtre courante, à défaut de la précédente ; une sortie illisible ou étrangère n’en donne aucun', () => {
  const out = JSON.stringify({ lotMinutes: { '0.5': { current: 42.4, previous: 30 }, '1': { current: null, previous: 80 }, '2': { current: null, previous: null }, '3': { current: 'x' } } })
  expect(parseTypical(out)).toEqual({ '0.5': 42.4, '1': 80 })
  expect(parseTypical('pas du json')).toEqual({})
  expect(parseTypical(JSON.stringify([1]))).toEqual({})
  expect(parseTypical(JSON.stringify({ lotMinutes: 3 }))).toEqual({})
})
