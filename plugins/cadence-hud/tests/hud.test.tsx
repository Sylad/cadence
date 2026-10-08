import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { parseWaves } from '../hooks/collect'
import { ago, attributeTurn, endedCommands, endedTask, notifiedEnd, pruneOwners, startedCommand, stoppedTask, trackCommand, bar, colorOfLot, colorOfPercent, commonProject, cells, duration, fit, k, lotCells, lotCounts, lotText, fitSegments, RESET_BACK, modelsText, parseAmbiguous, shortModel, wavePercent } from '../hooks/format'
import type { Wave } from '../types'

/** Minuterie du moteur de test (absente des types du module, qui n'a ni DOM ni Node) : pour laisser se poser un travail lancé sans être attendu. */
declare function setTimeout(fn: () => void, ms?: number): unknown

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
  expect(k(undefined)).toBe('-')
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
const seed = (on: On, values: Record<string, unknown>, env: Record<string, string> = {}) => {
  mock.env(on, env)
  on('state.get', (_$, e, next) =>
    e.plugin === PLUGIN && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e),
  )
}

const EMPTY = { commands: [], commandOwners: {}, agents: { running: 0, names: [] }, models: { byModel: {}, usdSeen: 0 }, error: null, isHidden: false }

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

test('les lots d’une vague sont alignés par des Box à largeur fixe, sans espaces de remplissage', async ($, on) => {
  seed(on, { ...EMPTY, usage: { percent: 42, window: 200_000, limits: [] }, waves: [WAVE], now: Date.parse('2026-10-07T19:14:11.066Z') })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    const boxes = await ui.findAll({ type: 'Box' })
    const fixed = boxes.filter(b => b.props.flexShrink === 0 && typeof b.props.width === 'number' && b.props.paddingLeft === 2)
    // colonne des lots : « L75 » (3) + 2 ; colonne des états : « en attente » (10) + 2, sur la ligne du lot et sur celle des lots en attente
    expect(fixed.some(b => b.props.width === 5)).toBe(true)
    expect(fixed.filter(b => b.props.width === 12)).toHaveLength(2)
    // le titre prend la largeur restante et se tronque
    expect(boxes.filter(b => b.props.flexGrow === 1 && b.props.flexShrink === 1)).toHaveLength(2)
    // aucun texte n'est rembourré d'espaces : l'alignement ne dépend pas de leur rendu
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.filter(t => !t.text?.includes('│') && /^\s*$|\s{2,}$/.test(t.text ?? ''))).toEqual([])
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
  ).toBe('fable 410k sonnet 85k')
  expect(modelsText({ byModel: { opus: { tokens: 1_200_000, usd: 2 }, sonnet: { tokens: 800_000, usd: 1 } }, usdSeen: 3 })).toBe('opus 1.2M sonnet 800k')
  expect(modelsText({ byModel: {}, usdSeen: 0 })).toBe('')
})

test('la bande montre les tokens de chaque modèle, du plus cher au moins cher', async ($, on) => {
  seed(on, {
    ...EMPTY,
    usage: { percent: 9, tokens: 90_000, window: 1_000_000, usd: 1.07, limits: [] },
    models: { byModel: { fable: { tokens: 410_000, usd: 0.95 }, sonnet: { tokens: 85_300, usd: 0.12 } }, usdSeen: 1.07 },
    waves: [],
    now: 0,
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /fable 410k sonnet 85k/ })).toBeDefined()
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

test('les segments tombent par priorité jusqu’à tenir dans la largeur', () => {
  const segs = [
    { key: 'ctx', text: 'ctx 1234567890', drop: 0 },
    { key: '5h', text: ' | 5h 12 %', drop: 1 },
    { key: 'usd', text: ' | $1.31', drop: 3 },
    { key: 'models', text: ' | fable 416k $1.47', drop: 5 },
  ]
  expect(fitSegments(segs, 200).map(s => s.key)).toEqual(['ctx', '5h', 'usd', 'models'])
  expect(fitSegments(segs, 40).map(s => s.key)).toEqual(['ctx', '5h', 'usd'])
  expect(fitSegments(segs, 20).map(s => s.key)).toEqual(['ctx'])
  expect(fitSegments(segs, 5).map(s => s.key)).toEqual(['ctx'])
})

test('fitSegments reprend les petits segments qui tiennent une fois le gros tombé (cas de la capture du 08-10)', () => {
  const segs = [
    { key: 'ctx', text: 'c'.repeat(30), drop: 0 },
    { key: '5h', text: ' | 5h 12 %', drop: 1 },
    { key: '5h-reset', text: ' r 1 h 10', drop: 5, requires: '5h' },
    { key: 'usd', text: ' | $1.31', drop: 3 },
    { key: 'models', text: ` | ${'m'.repeat(40)}`, drop: 4 },
  ]
  // tout = 30 + 10 + 9 + 8 + 43 = 100 ; sans modèles = 57 : à 70 cellules, les modèles ne tiennent pas mais le reste oui
  expect(fitSegments(segs, 70).map(s => s.key)).toEqual(['ctx', '5h', '5h-reset', 'usd'])
  // 50 : ni les modèles (43) ni la remise à zéro (9) ne rentrent dans les 2 cellules qui restent avec le coût
  expect(fitSegments(segs, 50).map(s => s.key)).toEqual(['ctx', '5h', 'usd'])
  // 57 : juste de quoi reprendre la remise à zéro (48 + 9), pas les modèles
  expect(fitSegments(segs, 57).map(s => s.key)).toEqual(['ctx', '5h', '5h-reset', 'usd'])
  // un segment qui `requires` un segment tombé ne revient pas seul
  expect(fitSegments(segs, 35).map(s => s.key)).toEqual(['ctx'])
  expect(fitSegments(segs, 41).map(s => s.key)).toEqual(['ctx', '5h'])
})

test('fitSegments reprend la remise à zéro avant les modèles quand une seule place reste', () => {
  const segs = [
    { key: 'ctx', text: 'c'.repeat(39), drop: 0 },
    { key: '5h', text: 'f'.repeat(14), drop: 1 },
    { key: '5h-reset', text: 'r'.repeat(10), drop: 5, back: 3, requires: '5h' },
    { key: 'models', text: 'm'.repeat(15), drop: 4 },
    { key: 'agents', text: 'a'.repeat(16), drop: 2 },
  ]
  // 94 en tout ; à 68, heures, modèles et compteur tombent et il reste 15 cellules : la remise à zéro (10) passe avant les modèles (15)
  expect(fitSegments(segs, 68).map(s => s.key)).toEqual(['ctx', '5h', '5h-reset'])
})

test('fitSegments reprend le coût avant l\'heure de remise à zéro, puis l\'heure avant les modèles', () => {
  const segs = [
    { key: 'ctx', text: 'c'.repeat(40), drop: 0 },
    { key: '5h', text: 'f'.repeat(14), drop: 1 },
    { key: '5h-reset', text: 'r'.repeat(10), drop: 5, back: RESET_BACK, requires: '5h' },
    { key: 'usd', text: 'u'.repeat(11), drop: 3 },
    { key: 'models', text: 'm'.repeat(27), drop: 4 },
  ]
  // 102 en tout ; à 65, 11 cellules restent après ctx et 5h : le coût (11) passe avant l'heure (10)
  expect(fitSegments(segs, 65).map(s => s.key)).toEqual(['ctx', '5h', 'usd'])
  // 74 : le coût et l'heure tiennent, pas les modèles
  expect(fitSegments(segs, 75).map(s => s.key)).toEqual(['ctx', '5h', '5h-reset', 'usd'])
})

test('fitSegments ne reprend pas une heure dont la fenêtre de quota est tombée', () => {
  const segs = [
    { key: 'ctx', text: 'c'.repeat(39), drop: 0 },
    { key: '7d', text: 'f'.repeat(14), drop: 1 },
    { key: '7d-reset', text: 'r'.repeat(10), drop: 5, requires: '7d' },
  ]
  // 63 en tout ; à 52, la remise à zéro puis 7j tombent (39), il reste 13 : l'heure (10) tiendrait mais sans sa fenêtre elle ne revient pas
  expect(fitSegments(segs, 52).map(s => s.key)).toEqual(['ctx'])
})

test('cells compte en pire cas les caractères de largeur ambiguë (▰▱⚙│↻) et les larges pour 2 cellules', () => {
  expect(cells('abc')).toBe(3)
  expect(cells('▰▰▱')).toBe(6)
  expect(cells('⚙ 2')).toBe(4)
  expect(cells('  │  ')).toBe(6)
  expect(cells('↻ 2 h')).toBe(6)
  expect(cells('日本')).toBe(4)
  expect(cells('éa')).toBe(2)
})

test('la largeur des caractères ambigus vaut 1 ou 2 (défaut 2, pire cas), les larges restent à 2', () => {
  expect(parseAmbiguous(undefined)).toBe(2)
  expect(parseAmbiguous('2')).toBe(2)
  expect(parseAmbiguous('n importe quoi')).toBe(2)
  expect(parseAmbiguous('1')).toBe(1)
  expect(cells('▰▰│↻⚙')).toBe(10)
  expect(cells('▰▰│↻⚙ 日', 1)).toBe(8)
  expect(cells('  │  ', 1)).toBe(5)
  const segs = [
    { key: 'ctx', text: `ctx ${bar(50)}`, drop: 0 },
    { key: 'agents', text: '  │  ⚙ 2 agents', drop: 2 },
  ]
  // largeur 1 : 14 + 14 = 28 cellules ; largeur 2 : 44
  expect(fitSegments(segs, 30, 1).map(s => s.key)).toEqual(['ctx', 'agents'])
  expect(fitSegments(segs, 30, 2).map(s => s.key)).toEqual(['ctx'])
  expect(fitSegments(segs, 30).map(s => s.key)).toEqual(['ctx'])
})

test('CADENCE_HUD_AMBIGUOUS=1 libère les 14 cellules du pire cas sur la première ligne', async ($, on) => {
  seed(on, {
    ...EMPTY,
    agents: { running: 1, names: ['tour-maritime'] },
    usage: { percent: 9, tokens: 87_000, window: 1_000_000, usd: 1.31, limits: [] },
    waves: [],
    now: 0,
  }, { CADENCE_HUD_AMBIGUOUS: '1' })
  const props = { ...BAND.props, bodyColumns: 50 }
  const one = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND, props })
  expect(await one.find({ type: 'Text', text: /⚙ 1 agent/ })).toBeDefined()
  await one.unmount()
})

test('sans CADENCE_HUD_AMBIGUOUS, la même fenêtre de 50 colonnes lâche le compteur d\'agents (pire cas)', async ($, on) => {
  seed(on, {
    ...EMPTY,
    agents: { running: 1, names: ['tour-maritime'] },
    usage: { percent: 9, tokens: 87_000, window: 1_000_000, usd: 1.31, limits: [] },
    waves: [],
    now: 0,
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND, props: { ...BAND.props, bodyColumns: 50 } })
  expect(await ui.find({ type: 'Text', text: /87k\/1M/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚙ 1 agent/ })).toBeUndefined()
  await ui.unmount()
})

test('fitSegments mesure en cellules : une barre ▰▱ de 10 cases pèse 20 cellules', () => {
  const segs = [
    { key: 'ctx', text: `ctx ${bar(50)}`, drop: 0 },
    { key: 'agents', text: '  │  ⚙ 2 agents', drop: 2 },
  ]
  // 14 caractères de ctx + 14 d'agents = 28 en String.length, mais 24 + 20 = 44 cellules.
  expect(fitSegments(segs, 30).map(s => s.key)).toEqual(['ctx'])
  expect(fitSegments(segs, 44).map(s => s.key)).toEqual(['ctx', 'agents'])
})

test('dans une fenêtre étroite, la première ligne lâche les modèles et les agents avant les fenêtres de quota', async ($, on) => {
  seed(on, {
    ...EMPTY,
    agents: { running: 1, names: ['tour-maritime'] },
    usage: {
      percent: 9,
      tokens: 87_000,
      window: 1_000_000,
      usd: 1.31,
      limits: [
        { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-10-08T05:00:00Z' },
        { kind: 'seven_day', percentUsed: 6, resetsAt: '2026-10-14T05:00:00Z' },
      ],
    },
    models: { byModel: { fable: { tokens: 416_000, usd: 1.47 }, haiku: { tokens: 190_000, usd: 0.03 } }, usdSeen: 1.5 },
    waves: [],
    now: Date.parse('2026-10-08T00:11:00Z'),
  })
  const narrow = { ...BAND, props: { ...BAND.props, bodyColumns: 70 } }
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...narrow })
  expect(await ui.find({ type: 'Text', text: /87k\/1M/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5h $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^7j $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fable/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /tour-maritime/ })).toBeUndefined()
  await ui.unmount()

  // 140 colonnes (mesurées en cellules, ▰▱⚙│↻ comptés double) : tout tient sauf les noms d'agents
  const wide = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND, props: { ...BAND.props, bodyColumns: 140 } })
  expect(await wide.find({ type: 'Text', text: /fable 416k haiku 190k/ })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /↻ 4 h 49/ })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /⚙ 1 agent/ })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /tour-maritime/ })).toBeUndefined()
  await wide.unmount()

  // 115 colonnes (cas de la capture du 08-10) : les modèles (27 cellules) ne tiennent pas, mais les heures de
  // remise à zéro et le compteur d'agents, plus petits, restent
  const mid = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND, props: { ...BAND.props, bodyColumns: 115 } })
  expect(await mid.find({ type: 'Text', text: /fable/ })).toBeUndefined()
  expect(await mid.find({ type: 'Text', text: /↻ 4 h 49/ })).toBeDefined()
  expect(await mid.find({ type: 'Text', text: /↻ 6 j 4 h/ })).toBeDefined()
  expect(await mid.find({ type: 'Text', text: /⚙ 1 agent/ })).toBeDefined()
  await mid.unmount()

  const huge = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND, props: { ...BAND.props, bodyColumns: 200 } })
  expect(await huge.find({ type: 'Text', text: /↻ 4 h 49/ })).toBeDefined()
  expect(await huge.find({ type: 'Text', text: /tour-maritime/ })).toBeDefined()
  await huge.unmount()
})

test('fit coupe avec trois points ASCII, sans dépasser la largeur', () => {
  expect(fit('abcdefghij', 10)).toBe('abcdefghij')
  expect(fit('abcdefghij', 8)).toBe('abcde...')
  expect(fit('abcdefghij', 3)).toBe('...')
  expect(fit('abcdefghij', 2)).toBe('')
})

test('la première ligne n\'emploie que de l\'ASCII et les symboles que cells() sait compter (▰▱⚙│↻)', async ($, on) => {
  seed(on, {
    ...EMPTY,
    agents: { running: 2, names: ['un-nom-d-agent-tres-long', 'un-autre-nom-d-agent-tres-long', 'et-encore-un-troisieme'] },
    usage: {
      percent: undefined,
      tokens: undefined,
      window: undefined,
      usd: 1.31,
      limits: [
        { kind: 'five_hour', percentUsed: undefined, resetsAt: '2026-10-08T05:00:00Z' },
        { kind: 'seven_day', percentUsed: 6, resetsAt: '2026-10-14T05:00:00Z' },
        { kind: 'spend_limit', percentUsed: 12, resetsAt: '2026-10-14T05:00:00Z' },
      ],
    },
    models: {
      byModel: {
        'un-modele-au-nom-tres-long-1': { tokens: 416_000, usd: 1.47 },
        'un-modele-au-nom-tres-long-2': { tokens: 190_000, usd: 0.03 },
      },
      usdSeen: 1.5,
    },
    waves: [],
    now: Date.parse('2026-10-08T00:11:00Z'),
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND, props: { ...BAND.props, bodyColumns: 400 } })
  expect(await ui.find({ type: 'Text', text: /↻ \d/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\.\.\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /EUR/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /[^\x00-\x7f▰▱⚙│↻]/ })).toBeUndefined()
  await ui.unmount()
})

test('une commande d\'arrière-plan démarre par Bash (run_in_background ou mise en arrière-plan) ou Monitor, sous-agents compris', () => {
  expect(startedCommand('Bash', { backgroundTaskId: 'b1' })).toBe('b1')
  expect(startedCommand('Bash', { stdout: '', interrupted: false })).toBeNull()
  expect(startedCommand('Bash', { backgroundTaskId: 'b2', backgroundEndsWithFinalResponse: true })).toBeNull()
  expect(startedCommand('Monitor', { taskId: 'm1', timeoutMs: 300_000 })).toBe('m1')
  expect(startedCommand('Read', { taskId: 'x' })).toBeNull()
  expect(startedCommand('Bash', null)).toBeNull()
})

test('une commande d\'arrière-plan finit par sa notification', () => {
  const note = (id: string, status: string) =>
    `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>t</tool-use-id>\n<status>${status}</status>\n<summary>Background command "x" ${status}</summary>\n</task-notification>`
  expect(endedTask(note('b1', 'completed'))).toBe('b1')
  expect(endedTask(note('b1', 'failed'))).toBe('b1')
  expect(endedTask(note('b1', 'killed'))).toBe('b1')
  // l'événement d'un Monitor qui tourne encore n'est pas une fin
  expect(endedTask('<task-notification>\n<task-id>m1</task-id>\n<event>ligne</event>\n</task-notification>')).toBeNull()
  expect(endedTask(note('b1', 'running'))).toBeNull()
  expect(endedTask('bonjour')).toBeNull()
})

test('les commandes en cours ne comptent chaque tâche qu\'une fois et la perdent à sa fin', () => {
  let ids: string[] = []
  ids = trackCommand(ids, 'b1', true)
  ids = trackCommand(ids, 'b1', true)
  ids = trackCommand(ids, 'm1', true)
  expect(ids).toEqual(['b1', 'm1'])
  ids = trackCommand(ids, 'b1', false)
  expect(ids).toEqual(['m1'])
  expect(trackCommand(ids, 'inconnue', false)).toEqual(['m1'])
})

test('la bande compte les commandes d\'arrière-plan à côté des agents', async ($, on) => {
  seed(on, {
    ...EMPTY,
    agents: { running: 1, names: ['tour'] },
    commands: ['b1', 'm1'],
    usage: { percent: 42, tokens: 84_000, window: 200_000, limits: [] },
    waves: [],
    now: 0,
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /⚙ 1 agent/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 cmd/ })).toBeDefined()
    await ui.unmount()
  }
})

test('sans commande en cours, la bande n\'affiche pas « cmd »', async ($, on) => {
  seed(on, { ...EMPTY, commands: [], usage: { percent: 42, window: 200_000, limits: [] }, waves: [], now: 0 })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /42 %/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cmd/ })).toBeUndefined()
  await ui.unmount()
})

test('une commande seule, sans agent, s\'affiche quand même', async ($, on) => {
  seed(on, { ...EMPTY, commands: ['b1'], usage: { percent: 42, window: 200_000, limits: [] }, waves: [], now: 0 })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /1 cmd/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agent/ })).toBeUndefined()
  await ui.unmount()
})

test('TaskStop retire la tâche arrêtée, lue dans task_id du résultat', () => {
  expect(stoppedTask('TaskStop', { message: 'Successfully stopped task: b1', task_id: 'b1', task_type: 'local_bash' })).toBe('b1')
  expect(stoppedTask('TaskStop', { taskId: 'b1' })).toBeNull()
  expect(stoppedTask('TaskStop', { task_id: 7 })).toBeNull()
  expect(stoppedTask('TaskStop', null)).toBeNull()
  expect(stoppedTask('Bash', { task_id: 'b1' })).toBeNull()
})

test('seule une notification de tâche (origin.kind) peut terminer une commande', () => {
  const text = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'
  expect(notifiedEnd({ kind: 'task-notification' }, text)).toBe('b1')
  expect(notifiedEnd({ kind: 'user' }, text)).toBeNull()
  expect(notifiedEnd(undefined, text)).toBeNull()
})

/**
 * Branche l'état du mod en mémoire (`state.get` relit, `state.set` écrit en versionnant) et répond à `tool.call` par
 * le résultat que le test pose dans `answer` : les événements passent par les hooks du mod, le test lit ce qu'il a écrit.
 */
const wired = (on: On) => {
  const store = new Map<string, { value: unknown; version: number }>()
  const answer: { current: Record<string, unknown> } = { current: {} }
  on('state.get', (_$, e) => ({ value: store.get(e.key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_$, e) => {
    const version = (store.get(e.key)?.version ?? 0) + 1
    store.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } } as never
  })
  on('tool.call', () => answer.current as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  return { answer, commands: () => store.get('commands')?.value ?? [], owners: () => store.get('commandOwners')?.value ?? {} }
}

const NOTIFICATION = (id: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Background command "x" completed</summary>\n</task-notification>`

test('un Bash lancé en arrière-plan entre dans les commandes, par le hook tool.call', async ($, on) => {
  const hud = wired(on)
  hud.answer.current = { result: { backgroundTaskId: 'b1' } }
  await $.tool.call({ tool: 'Bash', input: { command: 'sleep 60', run_in_background: true } } as never)
  expect(hud.commands()).toEqual(['b1'])
  hud.answer.current = { result: { taskId: 'm1' } }
  await $.tool.call({ tool: 'Monitor', input: { command: 'tail -f x' } } as never)
  expect(hud.commands()).toEqual(['b1', 'm1'])
})

test('un résultat en erreur ou un Bash au premier plan n\'ajoute rien', async ($, on) => {
  const hud = wired(on)
  hud.answer.current = { isError: true, result: { backgroundTaskId: 'b1' } }
  await $.tool.call({ tool: 'Bash', input: { command: 'sleep 60', run_in_background: true } } as never)
  expect(hud.commands()).toEqual([])
  hud.answer.current = { result: { stdout: 'ok', interrupted: false } }
  await $.tool.call({ tool: 'Bash', input: { command: 'ls' } } as never)
  expect(hud.commands()).toEqual([])
})

test('TaskStop retire la tâche arrêtée, par le hook tool.call', async ($, on) => {
  const hud = wired(on)
  hud.answer.current = { result: { backgroundTaskId: 'b1' } }
  await $.tool.call({ tool: 'Bash', input: { run_in_background: true } } as never)
  hud.answer.current = { result: { backgroundTaskId: 'b2' } }
  await $.tool.call({ tool: 'Bash', input: { run_in_background: true } } as never)
  expect(hud.commands()).toEqual(['b1', 'b2'])
  hud.answer.current = { result: { message: 'Successfully stopped task: b1', task_id: 'b1', task_type: 'local_bash' } }
  await $.tool.call({ tool: 'TaskStop', input: { task_id: 'b1' } } as never)
  expect(hud.commands()).toEqual(['b2'])
})

test('la notification de fin retire la commande, un prompt tapé n\'en retire aucune', async ($, on) => {
  const hud = wired(on)
  hud.answer.current = { result: { backgroundTaskId: 'b1' } }
  await $.tool.call({ tool: 'Bash', input: { run_in_background: true } } as never)
  // même texte, mais écrit par l'utilisateur : ne termine rien
  await $.prompt.submit({ origin: { kind: 'composer' }, text: NOTIFICATION('b1') } as never)
  expect(hud.commands()).toEqual(['b1'])
  await $.prompt.submit({ origin: { kind: 'task-notification' }, text: NOTIFICATION('b1') } as never)
  expect(hud.commands()).toEqual([])
})

test('l’expiration d’un Monitor finit sa tâche, un événement ordinaire non', () => {
  const expired = '<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event: "x"</summary>\n<event>[Monitor expired after 30m with 16 events delivered. Re-arm it if you still need the watch.]</event>\n</task-notification>'
  expect(endedTask(expired)).toBe('m1')
  expect(endedTask('<task-notification>\n<task-id>m1</task-id>\n<event>Monitor expired ? non : une ligne du journal</event>\n</task-notification>')).toBeNull()
})

test('une tâche finie emporte les commandes de son sous-agent', () => {
  const owners = { b2: 'a1', m2: 'a1', b3: 'a2' }
  expect(endedCommands(['b1', 'b2', 'm2', 'b3'], owners, 'a1')).toEqual(['b1', 'b3'])
  expect(endedCommands(['b1', 'b2', 'm2', 'b3'], owners, 'b2')).toEqual(['b1', 'm2', 'b3'])
  expect(endedCommands(['b1'], {}, 'inconnue')).toEqual(['b1'])
  expect(pruneOwners(owners, ['b3'])).toEqual({ b3: 'a2' })
})

test('les commandes d’un sous-agent sortent du compte quand il finit, par les hooks', async ($, on) => {
  const hud = wired(on)
  hud.answer.current = { result: { backgroundTaskId: 'b1' } }
  await $.tool.call({ tool: 'Bash', input: { run_in_background: true } } as never)
  hud.answer.current = { result: { backgroundTaskId: 'b2' } }
  await $.tool.call({ tool: 'Bash', input: { run_in_background: true }, agentId: 'a1' } as never)
  hud.answer.current = { result: { taskId: 'm1' } }
  await $.tool.call({ tool: 'Monitor', input: { command: 'tail -f x' } } as never)
  expect(hud.commands()).toEqual(['b1', 'b2', 'm1'])
  expect(hud.owners()).toEqual({ b2: 'a1' })
  // fin du sous-agent a1 : b2 part avec lui, b1 et m1 restent
  await $.prompt.submit({ text: NOTIFICATION('a1'), origin: { kind: 'task-notification' } } as never)
  expect(hud.commands()).toEqual(['b1', 'm1'])
  expect(hud.owners()).toEqual({})
  // expiration du Monitor m1
  await $.prompt.submit({ text: '<task-notification>\n<task-id>m1</task-id>\n<event>[Monitor expired after 30m with 2 events delivered. Re-arm it if you still need the watch.]</event>\n</task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(hud.commands()).toEqual(['b1'])
})

test('session.start repart sans commande ni propriétaire (session neuve ou rechargement du mod)', async ($, on) => {
  const hud = wired(on)
  mock.clock(on)
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  hud.answer.current = { result: { backgroundTaskId: 'b1' } }
  await $.tool.call({ tool: 'Bash', input: { run_in_background: true }, agentId: 'a1' } as never)
  expect(hud.commands()).toEqual(['b1'])
  expect(hud.owners()).toEqual({ b1: 'a1' })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true } as never)
  expect(hud.commands()).toEqual([])
  expect(hud.owners()).toEqual({})
  // le premier rafraîchissement du hook est lancé sans être attendu (`void refresh()`) : le laisser se poser avant la fin du test
  await new Promise<void>(resolve => setTimeout(() => resolve(), 50))
})
