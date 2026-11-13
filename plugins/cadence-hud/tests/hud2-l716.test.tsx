import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { register } from '../hooks/register'

// L716 (D-1) : panneau des lots ouvert, la ligne du banc en cours reste dans la bande (le panneau ne la porte plus).
// D-1, suite de L716 (règle de Sylvain du 13-11, qui remplace la grille de cases de L716) : la bande ne montre que le travail en cours — runs, vagues,
// sessions, créneaux, banc en cours —, jamais l'avancement des projets, panneau ouvert ou fermé ; il est dans l'ordre des projets du panneau (tests/lots-pane.test.ts).

const PLUGIN = 'cadence-hud'
const band = (bodyColumns: number) =>
  ({
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns, scroll: { offset: 0, bodyRows: 12 }, view: {} },
  }) as const
const NOW = Date.parse('2026-11-13T08:30:00.000Z')
const EMPTY = { commands: [], commandOwners: {}, agents: { running: 0, names: [] }, models: { byModel: {}, usdSeen: 0 }, error: null, isHidden: false, waves: [], leadHolds: [], liveRuns: [], shownRuns: [], slotCap: 3 }
/** Treize projets, comme le dossier de Sylvain le 13-11, tels que le panneau les lit ; le premier a un lot en cours. */
const ROWS = Array.from({ length: 13 }, (_, i) => ({
  project: i === 0 ? 'cadence' : `projet-${i}`,
  doing: i === 0 ? [{ id: 'L716' }] : [],
  lots: [],
  progress: i === 0 ? { done: 679, doing: 1, todo: 14, added7: 5 } : { done: i, doing: 0, todo: 13 - i, added7: 0 },
}))
const EN_COURS = { debut: '2026-11-13T07:00:00.000Z', phase_debut: '2026-11-13T08:20:00.000Z', banc: '3-ol-companion-L241', phase: 'bras equipe-legere', bancs_total: 6, termines: 2, repetition: 1 }
const BANC = [{ date: '2026-11-08T09:00:00.000Z', vert: true, hebdo: true, bancs: ['1', '3', '6'], rouges: [], candidat: 'eq-legere' }]

const seed = (on: On, values: Record<string, unknown>) => {
  mock.env(on, {})
  on('state.get', (_$, e, next) => (e.plugin === PLUGIN && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e)))
}
const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

test('D-1, suite de L716 — treize projets, à 95 et 200 colonnes, panneau ouvert ou fermé : la bande n’a aucune barre d’avancement ni nom de projet, elle garde le banc en cours', async ($, on) => {
  const values: Record<string, unknown> = { ...EMPTY, usage: { percent: 42, tokens: 84_000, window: 200_000, limits: [] }, lotsBoard: { outdated: false, rows: ROWS }, banc: BANC, enCours: EN_COURS, now: NOW, lotsOpen: false }
  seed(on, values)
  for (const open of [false, true])
    for (const columns of [95, 200])
      for (const surface of ['terminal', 'desktop'] as const) {
        values.lotsOpen = open
        const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...band(columns) })
        const t = await texts(ui)
        expect(t).toMatch(/^banc ⟳ 3\/6 bancs/m)
        expect(t).not.toMatch(/[▮▯]{10}/)
        expect(t).not.toMatch(/679\/694|\d+\/13\b/)
        for (const r of ROWS) expect(t).not.toMatch(new RegExp(`^${r.project}( |$)`, 'm'))
        // l'historique du banc : dans la bande panneau fermé, dans le bloc « Banc » du panneau ouvert
        if (open) expect(t).not.toMatch(/^banc ✓/m)
        else expect(t).toMatch(/^banc ✓ 08-11/m)
        await ui.unmount()
      }
})

void register
