import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { COMPACT_GAP, compactCell, packCells } from '../hooks/format'
import { register } from '../hooks/register'
import type { Project } from '../types'

// L716 (D-1) : panneau des lots ouvert, deux informations ne disparaissent plus des deux côtés — la ligne du banc en cours (dans la bande, le panneau ne la porte plus)
// et l'avancement de chaque projet (la bande le garde en cases compactes ; la région « ordre des projets » du panneau n'a plus de barres : tests/lots-pane.test.ts).

const PLUGIN = 'cadence-hud'
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns: 140, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
const NOW = Date.parse('2026-11-13T08:30:00.000Z')
const EMPTY = { commands: [], commandOwners: {}, agents: { running: 0, names: [] }, models: { byModel: {}, usdSeen: 0 }, error: null, isHidden: false, waves: [], leadHolds: [], liveRuns: [], shownRuns: [], slotCap: 3 }
/** Treize projets, comme le dossier de Sylvain le 13-11 ; le premier a un lot en cours. */
const PROJECTS: Project[] = Array.from({ length: 13 }, (_, i) => ({
  project: i === 0 ? 'cadence' : `projet-${i}`,
  doing: i === 0 ? [{ id: 'L716' }] : [],
  progress: i === 0 ? { done: 679, doing: 1, todo: 14, added7: 5 } : { done: i, doing: 0, todo: 13 - i, added7: 0 },
}))
const EN_COURS = { debut: '2026-11-13T07:00:00.000Z', phase_debut: '2026-11-13T08:20:00.000Z', banc: '3-ol-companion-L241', phase: 'bras equipe-legere', bancs_total: 6, termines: 2, repetition: 1 }
const BANC = [{ date: '2026-11-08T09:00:00.000Z', vert: true, hebdo: true, bancs: ['1', '3', '6'], rouges: [], candidat: 'eq-legere' }]

const seed = (on: On, values: Record<string, unknown>) => {
  mock.env(on, {})
  on('state.get', (_$, e, next) => (e.plugin === PLUGIN && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e)))
}
const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

test('L716 — la case compacte d’un projet : nom, les dix cases de la bande, fait/total ; ni lots en cours ni +N cette semaine', () => {
  expect(compactCell(PROJECTS[0]!)).toEqual({ name: 'cadence', bar: '▮▮▮▮▮▮▮▮▮▯', color: 'success', figures: '679/694', width: 'cadence ▮▮▮▮▮▮▮▮▮▯ 679/694'.length })
})

test('L716 — les cases se rangent dans l’ordre reçu, autant par ligne que la largeur en tient, l’écart compris', () => {
  const c = (width: number) => ({ width })
  expect(packCells([c(10), c(10), c(10)], 23)).toEqual([[c(10), c(10)], [c(10)]])
  expect(packCells([c(10), c(10), c(10)], 22)).toEqual([[c(10)], [c(10)], [c(10)]])
  expect(packCells([c(30), c(5)], 20)).toEqual([[c(30)], [c(5)]]) // plus large que la ligne : seule sur la sienne
  expect(packCells([], 80)).toEqual([])
  // à 140 colonnes, les treize projets tiennent en quelques lignes, chacune dans la largeur
  const rows = packCells(PROJECTS.map(compactCell), 140)
  expect(rows.flat()).toHaveLength(13)
  expect(rows.length).toBeLessThanOrEqual(4)
  for (const r of rows) expect(r.reduce((n, x) => n + x.width, 0) + COMPACT_GAP * (r.length - 1)).toBeLessThanOrEqual(140)
})

test('L716 — panneau ouvert, treize projets et un banc en cours : la bande garde la ligne du banc en cours et la barre de chaque projet, sans répéter l’arbre ni l’historique du banc', async ($, on) => {
  const values: Record<string, unknown> = { ...EMPTY, usage: { percent: 42, tokens: 84_000, window: 200_000, limits: [] }, projects: PROJECTS, banc: BANC, enCours: EN_COURS, now: NOW, lotsOpen: true }
  seed(on, values)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    const t = await texts(ui)
    expect(t).toMatch(/^banc ⟳ 3\/6 bancs/m)
    for (const p of PROJECTS) expect(t).toMatch(new RegExp(`^${p.project} $`, 'm'))
    expect(t).toMatch(/679\/694/)
    expect(t).toMatch(/12\/13/)
    expect(t).not.toMatch(/en cours : L716/) // l'arbre du panneau montre les lots en cours
    expect(t).not.toMatch(/cette semaine/)
    expect(t).not.toMatch(/^banc ✓/m) // l'historique est dans le panneau
    // avant l'avancement : Claude Code coupe la bande par le bas quand elle dépasse sa hauteur
    expect(t.search(/^banc ⟳/m)).toBeLessThan(t.search(/^cadence $/m))
    await ui.unmount()
  }
  // /hud projets replié : la ligne repliée, panneau ouvert comme fermé
  values.projectsFolded = true
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect(await texts(ui)).toMatch(/▸ projets \(13\)/)
  await ui.unmount()
})

test('L716 — panneau fermé : la liste des projets complète, une ligne chacun, comme avant', async ($, on) => {
  seed(on, { ...EMPTY, usage: null, projects: PROJECTS.slice(0, 2), banc: BANC, enCours: EN_COURS, now: NOW, lotsOpen: false })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  const t = await texts(ui)
  expect(t).toMatch(/679\/694 · 1 en cours : L716 · \+5 cette semaine/)
  expect(t).toMatch(/^banc ⟳ 3\/6 bancs/m)
  expect(t).toMatch(/^banc ✓ 08-11/m)
  await ui.unmount()
})

void register
