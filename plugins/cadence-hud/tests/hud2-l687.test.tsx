import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { parseCollected } from '../hooks/collect'
import { register } from '../hooks/register'
import { RUNS_SHOWN, runCells, slotsLine } from '../hooks/format'
import { buildPanel, movedText } from '../hooks/lots'
import type { ShownRun, TourLot } from '../types'

// L687 (D-1) : HUD 2.0. La bande montre les cadence run et leur état ; elle ne répète pas ce que le panneau des lots montre déjà (la liste des projets, le banc) ;
// le panneau dit l'état d'un lot joué par un run (plus « en sommeil ») ; « à commiter » seulement dans un dépôt git (tests/lots-pane.test.ts pour le geste).

const PLUGIN = 'cadence-hud'
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns: 140, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
const NOW = Date.parse('2026-11-13T08:30:00.000Z')

const RUN: ShownRun = {
  id: '20261113065602-42393',
  repo: '/home/s/projects/developpeur/cadence',
  lot: 'L687',
  etat: 'en-cours',
  role: 'session',
  debut: '2026-11-13T08:18:00.000Z',
  modele: 'opus',
  cout: 1.2,
  titre: 'L687 — HUD 2.0 (D-1) : montrer les cadence run en cours et leur état',
  vu: '2026-11-13T08:29:00.000Z',
}

test('L687 — un run se lit en quatre colonnes : dépôt:lot, état, détail (modèle, durée, coût), titre sans l’id du lot', () => {
  expect(runCells(RUN, NOW)).toEqual({ label: 'cadence:L687', status: 'en cours', detail: 'opus 12 min · $1.20', title: 'HUD 2.0 (D-1) : montrer les cadence run en cours et leur état' })
  // il attend le quota : l'heure de reprise (locale), pas une durée
  const quota = runCells({ ...RUN, etat: 'quota', role: 'attente', reprise: '2026-11-13T12:05:00.000Z', cout: 0 }, NOW)
  expect(quota.status).toBe('attend le quota')
  expect(quota.detail).toMatch(/^reprise \d\d:\d\d$/)
  // fini : depuis quand ; sans lot, l'id du run
  expect(runCells({ ...RUN, etat: 'integre', role: null, lot: null, titre: 'une demande' }, NOW)).toEqual({ label: 'cadence:20261113065602-42393', status: 'intégré', detail: 'il y a 1 min · $1.20', title: 'une demande' })
  expect(runCells({ ...RUN, etat: 'interrompu', role: null }, NOW).status).toBe('interrompu')
  expect(runCells({ ...RUN, etat: 'attente', role: null }, NOW).status).toBe('question')
  expect(runCells({ ...RUN, etat: 'porte-rouge', role: null }, NOW).status).toBe('porte rouge')
})

test('L687 — le collecteur rend les runs à montrer ; une entrée étrange est sautée, les champs absents prennent leur défaut', () => {
  const out = parseCollected(JSON.stringify({ waves: [], shownRuns: [RUN, { id: 3 }, null, { id: 'x', etat: 'integre', vu: RUN.vu }] }))
  expect(out.shownRuns).toEqual([RUN, { id: 'x', etat: 'integre', vu: RUN.vu, repo: '', lot: null, role: null, titre: '' }])
  expect(parseCollected('{}').shownRuns).toEqual([])
})

test('L687 — la ligne des créneaux compte les runs sans les nommer : chacun a sa ligne, la ligne ne la répète pas', () => {
  expect(slotsLine([], [], 3, [{ id: RUN.id, repo: RUN.repo }])).toBe('runs cadence run : 1 · créneaux libres : 2 sur 3')
})

const seed = (on: On, values: Record<string, unknown>) => {
  mock.env(on, {})
  on('state.get', (_$, e, next) => (e.plugin === PLUGIN && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e)))
}
const EMPTY = { commands: [], commandOwners: {}, agents: { running: 0, names: [] }, models: { byModel: {}, usdSeen: 0 }, error: null, isHidden: false, waves: [], leadHolds: [], liveRuns: [], slotCap: 3 }
const PROJECTS = [{ project: 'cadence', doing: [{ id: 'L687' }], progress: { done: 10, doing: 1, todo: 9, added7: 2 } }, { project: 'ol', progress: { done: 39, doing: 0, todo: 39, added7: 0 } }]
const BANC = [{ date: '2026-11-08T09:00:00.000Z', vert: true, hebdo: true, bancs: ['1', '3', '6'], rouges: [], candidat: 'eq-legere' }]

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

test('L687 — la bande montre chaque run et son état, le vivant en tête, sur le terminal comme sur le bureau', async ($, on) => {
  const ended = { ...RUN, id: 'fini', lot: 'L705', etat: 'integre', role: null, titre: 'L705 — coupes du socle' }
  seed(on, { ...EMPTY, usage: { percent: 42, tokens: 84_000, window: 200_000, limits: [] }, shownRuns: [RUN, ended], liveRuns: [{ id: RUN.id, repo: RUN.repo }], now: NOW, lotsOpen: false })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    const t = await texts(ui)
    expect(t).toMatch(/▶ run cadence:L687/)
    expect(t).toMatch(/^en cours$/m)
    expect(t).toMatch(/opus 12 min · \$1\.20/)
    expect(t).toMatch(/HUD 2\.0 \(D-1\)/)
    expect(t).toMatch(/run cadence:L705/)
    expect(t).toMatch(/^intégré$/m)
    expect(t).toMatch(/runs cadence run : 1 · créneaux libres : 2 sur 3/)
    expect(t.indexOf('L687')).toBeLessThan(t.indexOf('L705'))
    await ui.unmount()
  }
})

test('L687 — au-delà de RUNS_SHOWN runs, les autres se comptent sur une ligne', async ($, on) => {
  const many = Array.from({ length: RUNS_SHOWN + 2 }, (_, i) => ({ ...RUN, id: `r${i}`, lot: `L${900 + i}` }))
  seed(on, { ...EMPTY, usage: null, shownRuns: many, now: NOW, lotsOpen: false })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  const t = await texts(ui)
  expect(t).toMatch(/… \+2 runs/)
  expect(t).not.toMatch(new RegExp(`L${900 + RUNS_SHOWN}\\b`))
  await ui.unmount()
})

test('L687 — panneau des lots ouvert : la bande ne répète ni les lots en cours des projets ni le banc ; fermé, elle les montre', async ($, on) => {
  const base = { ...EMPTY, usage: { percent: 42, tokens: 84_000, window: 200_000, limits: [] }, projects: PROJECTS, banc: BANC, enCours: null, shownRuns: [RUN], now: NOW }
  const values: Record<string, unknown> = { ...base, lotsOpen: false }
  seed(on, values)
  const closed = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  const before = await texts(closed)
  expect(before).toMatch(/^cadence$/m)
  expect(before).toMatch(/10\/20/)
  expect(before).toMatch(/^banc /m)
  await closed.unmount()
  values.lotsOpen = true
  const open = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  const after = await texts(open)
  // L716 : l'avancement reste, en cases compactes, sans les lots en cours que l'arbre du panneau montre
  expect(after).toMatch(/10\/20/)
  expect(after).not.toMatch(/en cours : L687/)
  expect(after).not.toMatch(/^banc /m)
  // ce que le panneau n'a pas reste : le contexte et les runs
  expect(after).toMatch(/42 %/)
  expect(after).toMatch(/▶ run cadence:L687/)
  await open.unmount()
})

test('L687 — dans le panneau, un lot doing joué par un run vivant n’est plus « en sommeil » : « ⟳ run », ou « ⏸ run en quota » quand il attend', () => {
  const lot = (id: string, status: 'todo' | 'doing'): TourLot => ({ id, title: `Titre ${id}`, status, after: [] })
  const rows = [{ project: 'cadence', doing: [], drift: [], notes: [], next: null, repo: [], progress: { done: 0, doing: 2, todo: 0, added7: 0 }, lots: [lot('L687', 'doing'), lot('L688', 'doing')] }]
  const states = (runs: { project: string; lot: string; state: string }[]) =>
    buildPanel({ rows, columns: 80, height: 20, waves: [], runs, now: NOW }).lines.flatMap(l => (l.kind === 'lot' ? [`${l.id} ${l.state.text}`] : []))
  expect(states([])).toEqual(['L687 ◌ en sommeil', 'L688 ◌ en sommeil'])
  expect(states([{ project: 'cadence', lot: 'L687', state: 'en-cours' }])).toEqual(['L687 ⟳ run', 'L688 ◌ en sommeil'])
  expect(states([{ project: 'cadence', lot: 'L687', state: 'quota' }])).toEqual(['L687 ⏸ run en quota', 'L688 ◌ en sommeil'])
  // un run d'un autre dépôt ne prête pas son état
  expect(states([{ project: 'ol', lot: 'L687', state: 'en-cours' }])).toEqual(['L687 ◌ en sommeil', 'L688 ◌ en sommeil'])
})

test('L687 — « à commiter » seulement dans un dépôt git ; git sans réponse garde le conseil plutôt que de taire un commit dû', () => {
  const ask = { id: 'ol', place: 'before' as const, target: 'cadence' }
  expect(movedText('project', ask, true)).toBe('ol placé avant cadence — priority: du cadence.yaml est modifiée, à commiter')
  expect(movedText('project', ask, null)).toBe('ol placé avant cadence — priority: du cadence.yaml est modifiée, à commiter')
  expect(movedText('project', ask, false)).toBe('ol placé avant cadence — priority: du cadence.yaml est modifiée (dossier hors dépôt git : rien à commiter)')
  const lot = { id: 'L13', place: 'after' as const, target: 'L10' }
  expect(movedText('lot', lot, true)).toBe('L13 placé après L10 — le plan est modifié, à commiter (raf move ne commite pas)')
  expect(movedText('lot', lot, false)).toBe('L13 placé après L10 — le plan est modifié (dossier hors dépôt git : rien à commiter)')
})

void register
