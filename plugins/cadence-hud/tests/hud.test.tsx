import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { parseWaves } from '../hooks/collect'
import { ago, attributeTurn, bar, colorOfLot, colorOfPercent, commonProject, duration, k, lotCells, lotCounts, lotText, modelsText, shortModel, wavePercent } from '../hooks/format'
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
  live: true,
  budget: 1_000_000,
  consumed: 81_926,
  lots: [
    {
      project: 'cadence',
      lot: 'L75',
      title: 'raf show aligne les lignes suivantes d’une note',
      status: 'fixing',
      pass: 0,
      model: 'sonnet',
      next: 'fix',
      steps: 3,
      step: { kind: 'fix', model: 'sonnet', started: '2026-10-07T19:11:11.066Z', pid: 2, alive: true, sub: 0 },
    },
    { project: 'cadence', lot: 'L110', title: 'un lot en attente', status: 'queued', pass: 0, model: 'sonnet', next: null, steps: 0, step: null },
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
  expect(duration(23 * 3_600_000 + 59 * 60_000)).toBe('23 h 59')
  expect(duration(159 * 3_600_000 + 28 * 60_000)).toBe('6 j 15 h')
  expect(duration(72 * 3_600_000)).toBe('3 j')
})

test('un lot se lit en trois cellules ou en une ligne', () => {
  const at = Date.parse('2026-10-07T19:14:11.066Z')
  expect(lotCells(WAVE.lots[0]!, at)).toEqual({ lot: 'L75', status: 'corrige', detail: 'fix@sonnet 3 min' })
  expect(lotCells(WAVE.lots[1]!, at)).toEqual({ lot: 'L110', status: 'en attente', detail: '' })
  expect(lotText(WAVE.lots[0]!, at)).toBe('L75 corrige · fix@sonnet 3 min')
  expect(lotText(WAVE.lots[1]!, at)).toBe('L110 en attente')
  expect(wavePercent(WAVE)).toBe(8)
  expect(commonProject(WAVE)).toBe('cadence')
  expect(commonProject({ ...WAVE, lots: [WAVE.lots[0]!, { ...WAVE.lots[1]!, project: 'maritime' }] })).toBeNull()
})

test('le collecteur se lit, et une sortie étrange vaut aucune vague', () => {
  expect(parseWaves(JSON.stringify([WAVE]))[0]?.id).toBe(WAVE.id)
  expect(parseWaves(JSON.stringify([{ ...WAVE, live: undefined }]))[0]?.live).toBe(true)
  expect(parseWaves(JSON.stringify([{ ...WAVE, live: false }]))[0]?.live).toBe(false)
  expect(parseWaves('{}')).toEqual([])
  expect(() => parseWaves('pas du json')).toThrow()
})

/** Répond aux lectures d'état du mod depuis la mémoire du test (le kit n'a pas d'écriture d'état). */
const seed = (on: On, values: Record<string, unknown>) =>
  on('state.get', (_$, e, next) =>
    e.plugin === PLUGIN && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e),
  )

const EMPTY = { agents: { running: 0, names: [] }, models: { byModel: {}, usdSeen: 0 }, error: null, isHidden: false }

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
    expect(await ui.find({ type: 'Text', text: /cadence · 2026-10-07-2103 en cours/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^L75$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^corrige\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /fix@sonnet 3 min/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /raf show aligne les lignes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /un lot en attente/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^en attente$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^L110$/ })).toBeDefined()
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

const ENDED: Wave = {
  ...WAVE,
  id: '2026-10-07-2131',
  status: 'interrupted',
  live: false,
  ended: '2026-10-07T19:51:25.831Z',
  budget: 2_000_000,
  consumed: 440_181,
  lots: [
    { ...WAVE.lots[0]!, lot: 'L107', status: 'ready', step: null },
    { ...WAVE.lots[0]!, lot: 'L112', status: 'ready', step: null },
    { ...WAVE.lots[0]!, lot: 'L106', status: 'failed', step: null },
    { ...WAVE.lots[1]!, lot: 'L113', status: 'suspended' },
  ],
}

test('le bilan des lots et l’ancienneté se lisent', () => {
  expect(lotCounts(ENDED)).toBe('2 prêts · 1 échec · 1 suspendu')
  expect(lotCounts({ ...ENDED, lots: [] })).toBe('')
  expect(ago(ENDED.ended, Date.parse('2026-10-07T20:03:25.831Z'))).toBe('il y a 12 min')
  expect(ago(undefined, 0)).toBe('')
})

test('la dernière vague terminée reste en gris, sur une ligne, sans ses lots', async ($, on) => {
  seed(on, {
    ...EMPTY,
    usage: { percent: 9, tokens: 90_000, window: 1_000_000, limits: [] },
    waves: [ENDED],
    now: Date.parse('2026-10-07T20:03:25.831Z'),
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /cadence · 2026-10-07-2131 interrompue il y a 12 min/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /budget\s+22 % 440k\/2M/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 prêts · 1 échec · 1 suspendu/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^L107$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /session/ })).toBeUndefined()
  await ui.unmount()
})

test('la consommation par modèle se lit, du plus cher au moins cher', () => {
  expect(shortModel('claude-fable-5-1')).toBe('fable')
  expect(shortModel('claude-sonnet-5-5')).toBe('sonnet')
  expect(shortModel('us.anthropic.claude-opus-5-5-v1:0')).toBe('opus')
  expect(shortModel('gpt-x')).toBe('gpt-x')
  expect(
    modelsText({ byModel: { sonnet: { tokens: 85_300, usd: 0.12 }, fable: { tokens: 410_000, usd: 0.95 } }, usdSeen: 1.07 }),
  ).toBe('fable 410k $0.95 · sonnet 85k $0.12')
  expect(modelsText({ byModel: {}, usdSeen: 0 })).toBe('')
})

test('la bande montre la part de chaque modèle à côté du coût', async ($, on) => {
  seed(on, {
    ...EMPTY,
    usage: { percent: 9, tokens: 90_000, window: 1_000_000, usd: 1.07, limits: [] },
    models: { byModel: { fable: { tokens: 410_000, usd: 0.95 }, sonnet: { tokens: 85_300, usd: 0.12 } }, usdSeen: 1.07 },
    waves: [],
    now: 0,
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /fable 410k \$0\.95 · sonnet 85k \$0\.12/ })).toBeDefined()
  await ui.unmount()
})

test('l’attribution par tour : premier tour, total inconnu, inchangé ou plus bas, et la somme des parts vaut le total', () => {
  let m = attributeTurn({ byModel: {}, usdSeen: 0 }, 'fable', 1000, 0.5)
  const of = (name: string) => m.byModel[name] ?? { tokens: NaN, usd: NaN }
  expect(of('fable').tokens).toBe(1000)
  expect(of('fable').usd).toBe(0.5)
  expect(m.usdSeen).toBe(0.5)
  m = attributeTurn(m, 'sonnet', 200, undefined) // usage() en échec : les tokens comptent, rien n'est réparti
  expect(of('sonnet').tokens).toBe(200)
  expect(of('sonnet').usd).toBe(0)
  expect(m.usdSeen).toBe(0.5)
  m = attributeTurn(m, 'sonnet', 300, 0.5) // total inchangé
  expect(of('sonnet').tokens).toBe(500)
  expect(of('sonnet').usd).toBe(0)
  m = attributeTurn(m, 'fable', 100, 0.4) // total plus bas : jamais de part négative
  expect(of('fable').usd).toBe(0.5)
  expect(m.usdSeen).toBe(0.5)
  m = attributeTurn(m, 'sonnet', 100, 0.8)
  const sum = Object.values(m.byModel).reduce((a, s) => a + s.usd, 0)
  expect(Math.abs(sum - 0.8) < 1e-9).toBe(true)
  expect(m.usdSeen).toBe(0.8)
})
