import type { On } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './kit'

import { parseCollected } from '../hooks/collect'
import { register } from '../hooks/register'
import { closeLine, historyLine, holdAlive, slotsLine, staleHoldText } from '../hooks/format'
import type { LeadHold, ShownRun, Wave } from '../types'

// L802 (D-30) : la bande répond d'un coup d'œil à « puis-je fermer ? ». Le 20-11 à 18 h 50, elle montrait « 3 agents », un run L800 en cours, un run TYPO-1
// intégré et deux interrompus listés à égalité, « créneaux libres : 4 sur 5 » quand le lead se bornait à 3, et « session du lead échue : ux-L32 » pour une
// session qui ne tournait plus. Ce qui tourne se sépare de l'historique, seuls les agents qui travaillent comptent, une réservation échue sans rien de vivant
// le dit, les créneaux suivent le plafond appliqué, et une ligne dit « rien ne tourne, tu peux fermer ».

const PLUGIN = 'cadence-hud'
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 14, bodyColumns: 160, scroll: { offset: 0, bodyRows: 14 }, view: {} },
} as const
const NOW = Date.parse('2026-11-20T17:50:00.000Z')

const run = (id: string, lot: string, etat: string, role: string | null, repo = '/d/eywa'): ShownRun => ({
  id,
  repo,
  lot,
  etat,
  role,
  debut: '2026-11-20T17:38:00.000Z',
  modele: 'opus',
  cout: 0.5,
  titre: `${lot} — un titre`,
  vu: '2026-11-20T17:40:00.000Z',
})
const L800 = run('r800', 'L800', 'en-cours', 'session', '/d/maritime')
const TYPO_OK = run('t1', 'TYPO-1', 'integre', null)
const TYPO_X1 = run('t2', 'TYPO-1', 'interrompu', null)
const TYPO_X2 = run('t3', 'TYPO-1', 'interrompu', null)
const UX: LeadHold = { label: 'ux-L32', since: '2026-11-20T14:50:00.000Z', expires: '2026-11-20T15:50:00.000Z' }
const LIVE_HOLD: LeadHold = { label: 'revue-L9', since: '2026-11-20T17:40:00.000Z', expires: '2026-11-20T18:40:00.000Z' }
const WAVE: Wave = { id: '2026-11-20-1700', pid: 1, cwd: '/d', cap: 3, started: '2026-11-20T17:00:00.000Z', status: 'running', live: true, lanes: 1, lots: [] }

const seed = (on: On, values: Record<string, unknown>) => {
  mock.env(on, {})
  on('state.get', (_$, e, next) => (e.plugin === PLUGIN && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e)))
}
const EMPTY = {
  commands: [],
  commandOwners: {},
  commandInfo: {},
  agents: { running: 0, names: [] },
  models: { byModel: {}, usdSeen: 0 },
  error: null,
  isHidden: false,
  waves: [],
  leadHolds: [],
  liveRuns: [],
  shownRuns: [],
  slotCap: 3,
  slotSetting: 3,
  lotsOpen: false,
  banc: null,
  enCours: null,
  usage: { percent: 42, tokens: 84_000, window: 200_000, limits: [] },
  now: NOW,
}

type Ui = { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]>; unmount: () => Promise<void> }
const lines = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
const band = async ($: { ui: { mount: (o: never) => Promise<unknown> } }, values: Record<string, unknown>, working = false, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = (await $.ui.mount({ plugin: PLUGIN, surface, ...BAND, props: { ...BAND.props, isWorking: working } } as never)) as Ui
  const t = await lines(ui)
  await ui.unmount()
  return { t, all: t.join('\n') }
}

// ── les fonctions ──────────────────────────────────────────────────────────────

test('L802 — closeLine : « rien ne tourne » sans rien de vivant ; sinon nomme chaque source vivante, au singulier et au pluriel', () => {
  const none = { session: false, waves: 0, runs: 0, agents: 0, commands: 0, holds: 0, bench: false }
  expect(closeLine(none)).toEqual({ text: '✓ rien ne tourne : tu peux fermer', live: false })
  expect(closeLine(none, 1).text).toBe("✓ rien ne tourne : tu peux fermer (1 cmd sans fin vue depuis plus d'une heure : /hud cmd)")
  expect(closeLine({ ...none, runs: 1 })).toEqual({ text: '▶ tourne encore : 1 run', live: true })
  expect(closeLine({ session: true, waves: 2, runs: 2, agents: 3, commands: 1, holds: 2, bench: true }).text).toBe(
    '▶ tourne encore : cette session · 2 vagues · 2 runs · 3 agents · 1 cmd · 2 sessions du lead · banc',
  )
  expect(closeLine({ ...none, agents: 1, holds: 1, waves: 1 }).text).toBe('▶ tourne encore : 1 vague · 1 agent · 1 session du lead')
})

test('L802 — historyLine : les runs finis sur une ligne, groupés par état, un lot répété compté ; les vivants n’y sont jamais', () => {
  expect(historyLine([L800], NOW)).toBeNull()
  expect(historyLine([L800, TYPO_X1, TYPO_OK, TYPO_X2], NOW)).toBe('ne tourne plus : interrompu eywa:TYPO-1 ×2 · intégré eywa:TYPO-1')
  expect(historyLine([run('q', 'L7', 'attente', null), run('e', 'L8', 'echec', null, '/d/ol')], NOW)).toBe('ne tourne plus : question eywa:L7 · échec ol:L8')
})

test('L802 — holdAlive : vivante seulement si un agent qui travaille ou un run vivant la nomme ; L32 ne cite pas L320', () => {
  expect(holdAlive(UX, [], [TYPO_X1])).toBe(false)
  expect(holdAlive(UX, ['ux-L32'], [])).toBe(true)
  expect(holdAlive(UX, ['revue ux-L32 (bureau)'], [])).toBe(true)
  expect(holdAlive(UX, ['ux'], [])).toBe(false)
  expect(holdAlive({ ...UX, label: 'run-L32' }, [], [run('x', 'L32', 'en-cours', 'session')])).toBe(true)
  expect(holdAlive({ ...UX, label: 'run-L32' }, [], [run('x', 'L32', 'interrompu', null)])).toBe(false)
  expect(holdAlive({ ...UX, label: 'run-L32' }, [], [run('x', 'L320', 'en-cours', 'session')])).toBe(false)
  expect(staleHoldText(UX, NOW)).toBe('réservation échue, rien ne tourne : ux-L32  échue depuis 2 h 00 · cadence lead release ux-L32')
})

test('L802 — slotsLine dit l’écart quand le lead s’est borné sous le réglage ; rien quand ils sont égaux', () => {
  const runs = [{ id: 'r800', repo: '/d/maritime' }]
  expect(slotsLine([], [], 3, runs, 5)).toBe('runs cadence run : 1 · créneaux libres : 2 sur 3 (plafond du lead, réglage 5)')
  expect(slotsLine([], [], 3, runs, 3)).toBe('runs cadence run : 1 · créneaux libres : 2 sur 3')
  expect(slotsLine([], [], 3, runs)).toBe('runs cadence run : 1 · créneaux libres : 2 sur 3')
})

test('L802 — le collecteur rend le réglage à côté du plafond appliqué ; absent ou incohérent, il vaut le plafond', () => {
  expect(parseCollected(JSON.stringify({ waves: [], cap: 3, capSetting: 5 }))).toMatchObject({ cap: 3, capSetting: 5 })
  expect(parseCollected(JSON.stringify({ waves: [], cap: 3 }))).toMatchObject({ cap: 3, capSetting: 3 })
  expect(parseCollected(JSON.stringify({ waves: [], cap: 3, capSetting: 2 }))).toMatchObject({ cap: 3, capSetting: 3 })
})

// ── la bande, état par état ────────────────────────────────────────────────────

test('L802 — le cas du 20-11 : un run vivant en tête, l’historique replié sous la réponse, la réservation oubliée en gris, les créneaux sur 3 (réglage 5)', async ($, on) => {
  seed(on, { ...EMPTY, shownRuns: [L800, TYPO_X1, TYPO_X2, TYPO_OK], liveRuns: [{ id: L800.id, repo: L800.repo }], leadHolds: [UX], slotCap: 3, slotSetting: 5 })
  for (const surface of ['terminal', 'desktop'] as const) {
    const { t, all } = await band($, {}, false, surface)
    // une seule ligne de run : le vivant
    expect(t.filter(x => /^[▶ ] ?run /.test(x))).toEqual(['▶ run maritime:L800'])
    expect(all).toMatch(/runs cadence run : 1 · créneaux libres : 2 sur 3 \(plafond du lead, réglage 5\)/)
    expect(t).toContain('▶ tourne encore : 1 run')
    expect(t).toContain('  ne tourne plus : interrompu eywa:TYPO-1 ×2 · intégré eywa:TYPO-1')
    expect(t).toContain('  réservation échue, rien ne tourne : ux-L32  échue depuis 2 h 00 · cadence lead release ux-L32')
    expect(all).not.toMatch(/⚠ session du lead échue/)
    // l'ordre : ce qui tourne, la réponse, puis l'historique
    const at = (re: RegExp) => t.findIndex(x => re.test(x))
    expect(at(/^▶ run maritime:L800/)).toBeLessThan(at(/^▶ tourne encore/))
    expect(at(/^▶ tourne encore/)).toBeLessThan(at(/ne tourne plus/))
    expect(at(/ne tourne plus/)).toBeLessThan(at(/réservation échue/))
  }
})

test('L802 — rien ne tourne : la ligne le dit, même avec un historique et une réservation oubliée ; pas de ligne de créneaux', async ($, on) => {
  seed(on, { ...EMPTY, shownRuns: [TYPO_X1, TYPO_OK], leadHolds: [UX] })
  const { t, all } = await band($, {})
  expect(t).toContain('✓ rien ne tourne : tu peux fermer')
  expect(all).not.toMatch(/créneaux libres/)
  expect(all).not.toMatch(/tourne encore/)
  expect(t).toContain('  ne tourne plus : interrompu eywa:TYPO-1 · intégré eywa:TYPO-1')
})

test('L802 — rien du tout : la bande dit quand même qu’on peut fermer', async ($, on) => {
  seed(on, EMPTY)
  const { t } = await band($, {})
  expect(t).toContain('✓ rien ne tourne : tu peux fermer')
})

test('L802 — la session qui travaille compte : « cette session »', async ($, on) => {
  seed(on, EMPTY)
  const { t } = await band($, {}, true)
  expect(t).toContain('▶ tourne encore : cette session')
})

test('L802 — une vague vivante, une session du lead non échue, le banc en cours : chacun retient la fermeture', async ($, on) => {
  seed(on, { ...EMPTY, waves: [WAVE], leadHolds: [LIVE_HOLD], enCours: { run: 'b', debut: '2026-11-20T17:45:00.000Z', candidat: 'eq', reference: 'A', bancs_total: 3, banc: '1', repetition: 1, phase: 'candidat', phase_debut: '2026-11-20T17:46:00.000Z', termines: 0 } })
  const { t } = await band($, {})
  expect(t).toContain('▶ tourne encore : 1 vague · 1 session du lead · banc')
})

test('L802 — les agents : seul le nombre de ceux qui travaillent s’affiche, et il retient la fermeture', async ($, on) => {
  seed(on, { ...EMPTY, agents: { running: 2, names: ['livreur', 'qa'] } })
  const { t, all } = await band($, {})
  expect(all).toMatch(/⚙ 2 agents/)
  expect(t).toContain('▶ tourne encore : 2 agents')
})

test('L802 — une commande en cours retient la fermeture ; une commande sans fin vue depuis plus d’une heure non, elle est dite à côté', async ($, on) => {
  const started = NOW - 5 * 60_000
  seed(on, { ...EMPTY, commands: ['b1'], commandInfo: { b1: { tool: 'Bash', label: 'x', since: started } } })
  const live = await band($, {})
  expect(live.t).toContain('▶ tourne encore : 1 cmd')
})

test('L802 — une commande sans fiche (âge inconnu) ne retient pas : « rien ne tourne » la nomme', async ($, on) => {
  seed(on, { ...EMPTY, commands: ['b9'], commandInfo: {} })
  const { t } = await band($, {})
  expect(t).toContain("✓ rien ne tourne : tu peux fermer (1 cmd sans fin vue depuis plus d'une heure : /hud cmd)")
})

void register
