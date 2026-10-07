import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { parseWaves } from '../hooks/collect'
import { bar, colorOfLot, colorOfPercent, duration, k, lotText, wavePercent } from '../hooks/format'
import type { Wave } from '../types'

const PLUGIN = 'cadence-hud'
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const WAVE: Wave = {
  id: '2026-10-07-2103',
  pid: 1,
  cwd: '/x',
  cap: 2,
  started: '2026-10-07T19:03:10.939Z',
  status: 'running',
  budget: 1_000_000,
  consumed: 81_926,
  lots: [
    {
      project: 'cadence',
      lot: 'L75',
      status: 'fixing',
      pass: 0,
      model: 'sonnet',
      next: 'fix',
      steps: 3,
      step: { kind: 'fix', model: 'sonnet', started: '2026-10-07T19:11:11.066Z', pid: 2, alive: true, sub: 0 },
    },
    { project: 'cadence', lot: 'L110', status: 'queued', pass: 0, model: 'sonnet', next: null, steps: 0, step: null },
  ],
}

test('les couleurs suivent les seuils', () => {
  expect(colorOfPercent(undefined)).toBe('subtle')
  expect(colorOfPercent(10)).toBe('success')
  expect(colorOfPercent(70)).toBe('warning')
  expect(colorOfPercent(90)).toBe('error')
  expect(colorOfPercent(60, 50, 75)).toBe('warning')
  expect(colorOfLot('ready')).toBe('success')
  expect(colorOfLot('failed')).toBe('error')
  expect(colorOfLot('question')).toBe('warning')
  expect(colorOfLot('queued')).toBe('subtle')
  expect(colorOfLot('fixing')).toBe('claude')
})

test('les nombres, barres et durées sont courts', () => {
  expect(k(85_300)).toBe('85k')
  expect(k(1_000_000)).toBe('1M')
  expect(k(1_500_000)).toBe('1.5M')
  expect(k(undefined)).toBe('—')
  expect(bar(0)).toBe('▱▱▱▱▱▱▱▱▱▱')
  expect(bar(50)).toBe('▰▰▰▰▰▱▱▱▱▱')
  expect(bar(100)).toBe('▰▰▰▰▰▰▰▰▰▰')
  expect(duration(42_000)).toBe('42 s')
  expect(duration(3 * 60_000)).toBe('3 min')
  expect(duration(65 * 60_000)).toBe('1 h 05')
})

test('un lot se lit en une ligne', () => {
  const at = Date.parse('2026-10-07T19:14:11.066Z')
  expect(lotText(WAVE.lots[0]!, at)).toBe('L75 corrige · fix@sonnet 3 min')
  expect(lotText(WAVE.lots[1]!, at)).toBe('L110 en attente')
  expect(wavePercent(WAVE)).toBe(8)
})

test('le collecteur se lit, et une sortie étrange vaut aucune vague', () => {
  expect(parseWaves(JSON.stringify([WAVE]))[0]?.id).toBe(WAVE.id)
  expect(parseWaves('{}')).toEqual([])
  expect(() => parseWaves('pas du json')).toThrow()
})

/** Répond aux lectures d'état du mod depuis la mémoire du test (le kit n'a pas d'écriture d'état). */
const seed = (on: On, values: Record<string, unknown>) =>
  on('state.get', (_$, e, next) =>
    e.plugin === PLUGIN && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e),
  )

const EMPTY = { agents: { running: 0, names: [] }, error: null, isHidden: false }

test('la bande dessine le contexte et la vague sur chaque surface', async ($, on) => {
  seed(on, {
    ...EMPTY,
    usage: {
      percent: 42,
      tokens: 84_000,
      window: 200_000,
      usd: 1.23,
      limits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-07T23:00:00Z' }],
    },
    waves: [WAVE],
    now: Date.parse('2026-10-07T19:14:11.066Z'),
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /42 %/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2026-10-07-2103 en cours/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /L75 corrige · fix@sonnet 3 min/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /L110 en attente/ })).toBeDefined()
    await ui.unmount()
  }
})

test('masquée, la bande laisse la main', async ($, on) => {
  seed(on, { ...EMPTY, isHidden: true, usage: { percent: 42, window: 200_000, limits: [] }, waves: [], now: 0 })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">la bande du moteur</Text>
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /moteur/ })).toBeDefined()
  await ui.unmount()
})
