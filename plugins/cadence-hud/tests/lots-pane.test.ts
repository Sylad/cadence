import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { PLAN_STAMPS } from '../hooks/collect'
import type { LotsRow, TourLot, Wave } from '../types'

/** Minuterie du moteur de test (absente des types du module) : laisse se poser un travail lancé sans être attendu. */
declare function setTimeout(fn: () => void, ms?: number): unknown

const PLUGIN = 'cadence-hud'
const settle = () => new Promise<void>(resolve => setTimeout(() => resolve(), 50))
const lot = (id: string, status: 'todo' | 'doing' = 'todo', extra: Partial<TourLot> = {}): TourLot => ({ id, title: `Titre ${id}`, status, after: [], ...extra })
const row = (project: string, lots: TourLot[]) => ({ project, doing: [], drift: [], notes: [], next: null, repo: [], progress: { done: 0, doing: 1, todo: 1, added7: 0 }, lots })
const TOUR = [row('cadence', [lot('L401', 'doing'), lot('L401/1', 'doing', { parent: 'L401' }), lot('L401/2', 'todo', { parent: 'L401' }), lot('L402', 'todo', { after: ['L400', 'L401'] })]), row('ol', [lot('L80')])]

const WAVE: Wave = {
  id: 'w1', pid: 1, cwd: '/p', cap: 2, started: '2026-10-07T19:03:10.939Z', status: 'running', live: true, budget: 1_000_000, consumed: 1,
  lots: [{ project: 'ol', lot: 'L80', title: 't', status: 'reviewing', pass: 0, model: 'sonnet', next: null, steps: 1, step: null }],
}

type Cadence = { exitCode: number; stdout: string }

/** Monte le mod comme une session, avec un moteur simulé : état en mémoire, panneaux ouverts, processus pilotés par le test. */
const session = async ($: Parameters<TestBody>[0], on: On, setup: { tour?: () => Cadence | Promise<Cadence>; waves?: Wave[]; stamps?: () => string } = {}) => {
  const store = new Map<string, { value: unknown; version: number }>()
  const open = new Set<string>()
  const opened: unknown[] = []
  const runs: string[][] = []
  const clock = mock.clock(on)
  const tour = { current: setup.tour ?? ((): Cadence => ({ exitCode: 0, stdout: JSON.stringify(TOUR) })) }
  const stamps = { current: setup.stamps ?? ((): string => '{}') }
  const waves = { current: setup.waves ?? [] }
  on('state.get', (_$, e) => ({ value: store.get(e.key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_$, e) => {
    const version = (store.get(e.key)?.version ?? 0) + 1
    store.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } } as never
  })
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.open', (_$, e) => {
    opened.push(e)
    open.add(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', (_$, e) => {
    open.delete(e.id)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: 'Lots', isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('process.run', async (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    runs.push(argv)
    if (argv[0] === 'cadence') {
      const r = await tour.current()
      return { value: { ...r, stderr: '' } } as never
    }
    if (argv[3] === PLAN_STAMPS) return { value: { exitCode: 0, stdout: stamps.current(), stderr: '' } } as never
    return { value: { exitCode: 0, stdout: JSON.stringify({ waves: waves.current, holds: [], cap: 2 }), stderr: '' } } as never
  })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true } as never)
  await settle()
  const tours = () => runs.filter(a => a[0] === 'cadence')
  // laisse finir la lecture que l'ouverture lance sans l'attendre : un test qui s'arrête avant la verrait aboutir après le déchargement du mod
  const hud = async (args: string, columns = 140) => {
    const answer = await $.command.run({ command: 'hud', args, presentation: { columns, isFullscreen: true } } as never)
    await settle()
    return answer
  }
  const advance = async (ms: number) => {
    await clock.advance(ms)
    await settle()
  }
  const draw = async (bodyColumns = 70, bodyRows = 30) => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'Pane',
      requestId: 'lots',
      props: { title: 'Lots', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
    } as never)
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
    const buttons = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    return { texts, text: texts.join('\n'), buttons }
  }
  return { store, open, opened, runs, tours, tour, stamps, waves, hud, advance, draw }
}

const CLOSE_HELP = '/hud lots pour fermer'

test('R16 — /hud lots ouvre puis ferme le panneau', async ($, on) => {
  const s = await session($, on)
  const first = await s.hud('lots')
  expect(first.text).toMatch(/ouvert/)
  expect(s.opened).toMatchObject([{ id: 'lots', title: 'Lots' }])
  expect(s.open.has('lots')).toBe(true)
  const second = await s.hud('lots')
  expect(second.text).toMatch(/fermé/)
  expect(s.open.has('lots')).toBe(false)
})

test('R16 — le panneau n’est jamais ouvert de lui-même', async ($, on) => {
  const s = await session($, on)
  await s.advance(5_000)
  expect(s.opened).toEqual([])
})

test('R16 — argument inconnu : la réponse cite lots', async ($, on) => {
  const s = await session($, on)
  expect((await s.hud('lot')).text).toBe('argument inconnu : lot (attendu : cmd, projets, lots)')
  expect(s.opened).toEqual([])
})

test('R19 — terminal trop étroit : message, rien ne s’ouvre', async ($, on) => {
  const s = await session($, on)
  expect((await s.hud('lots', 109)).text).toBe('terminal trop étroit pour le panneau (110 colonnes au moins)')
  expect(s.opened).toEqual([])
  expect((await s.hud('lots', 110)).text).toMatch(/ouvert/)
})

test('R19 — un panneau déjà ouvert se ferme même si le terminal s’est rétréci', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots', 140)
  expect((await s.hud('lots', 80)).text).toMatch(/fermé/)
  expect(s.open.has('lots')).toBe(false)
})

test('R2 — avant la première lecture : message de lecture, pas de liste', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const s = await session($, on, { tour: async () => (await gate, { exitCode: 0, stdout: JSON.stringify(TOUR) }) })
  await s.hud('lots')
  await settle()
  const d = await s.draw()
  expect(d.text).toContain('Lecture des plans…')
  expect(d.text).not.toContain('L401')
  expect(d.text).toContain(CLOSE_HELP)
  release()
  await settle()
})

test('R3 — cadence absent : message d’erreur, pas de liste', async ($, on) => {
  const s = await session($, on, { tour: () => ({ exitCode: 127, stdout: '' }) })
  await s.hud('lots')
  await settle()
  const d = await s.draw()
  expect(d.text).toContain('Lots illisibles : cadence lead tour n\'a pas répondu. Nouvelle lecture dans une minute.')
  expect(d.text).not.toContain('L401')
  expect(d.text).toContain(CLOSE_HELP)
})

test('R3 — sortie illisible : message d’erreur', async ($, on) => {
  const s = await session($, on, { tour: () => ({ exitCode: 0, stdout: 'pas du json' }) })
  await s.hud('lots')
  await settle()
  expect((await s.draw()).text).toContain('Lots illisibles')
})

test('R3 — elle relit au cycle suivant, sans bouton', async ($, on) => {
  const ok = { current: false }
  const s = await session($, on, { tour: () => (ok.current ? { exitCode: 0, stdout: JSON.stringify(TOUR) } : { exitCode: 127, stdout: '' }) })
  await s.hud('lots')
  await settle()
  expect((await s.draw()).buttons).toEqual([])
  ok.current = true
  await s.advance(60_000)
  expect((await s.draw()).text).toContain('L401')
})

test('R1 — aucun lot non clos : le message d’état vide s’affiche, pas de liste', async ($, on) => {
  const s = await session($, on, { tour: () => ({ exitCode: 0, stdout: JSON.stringify([row('cadence', [])]) }) })
  await s.hud('lots')
  await settle()
  const d = await s.draw()
  expect(d.text).toContain('Aucun lot non clos dans les projets de ce dossier.')
  expect(d.text).not.toContain('cadence')
  expect(d.text).toContain(CLOSE_HELP)
})

test('R14 — lignes sans champ lots : message « cadence trop ancien », pas l’état vide', async ($, on) => {
  const old = [{ project: 'cadence', progress: { done: 1, doing: 1, todo: 1, added7: 0 } }]
  const s = await session($, on, { tour: () => ({ exitCode: 0, stdout: JSON.stringify(old) }) })
  await s.hud('lots')
  await settle()
  const d = await s.draw()
  expect(d.text).toContain('Lots indisponibles : cadence est trop ancien, mettez-le à jour.')
  expect(d.text).not.toContain('Aucun lot non clos')
  expect(d.text).toContain(CLOSE_HELP)
})

test('R4 — le panneau dessine un bloc par projet, ses lots en arbre et les after:', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await settle()
  const d = await s.draw()
  expect(d.texts.some(t => /cadence.*2 lots non clos/.test(t))).toBe(true)
  expect(d.texts.some(t => /ol.*1 lot non clos/.test(t))).toBe(true)
  expect(d.text).toContain('├')
  expect(d.text).toContain('└')
  expect(d.text).toContain('after: L400 L401')
  expect(d.text).toContain('L401/1')
  expect(d.text).toContain('▶ en cours')
  expect(d.text).toContain(CLOSE_HELP)
})

test('R5 — l’état de la vague l’emporte sur celui du plan, dans le panneau', async ($, on) => {
  const s = await session($, on, { waves: [WAVE] })
  await s.hud('lots')
  await settle()
  expect((await s.draw()).text).toContain('⟳ relit')
})

test('R8 — le rendu ne contient aucun bouton ni lien d’action', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await settle()
  const d = await s.draw()
  expect(d.buttons).toEqual([])
  expect(d.text).toContain('lecture seule')
})

test('R8 — l’heure de dernière lecture est affichée', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await settle()
  expect((await s.draw()).text).toMatch(/lu à \d\d:\d\d/)
})

test('R9 — relecture en échec : le dernier tableau reste affiché', async ($, on) => {
  const ok = { current: true }
  const s = await session($, on, { tour: () => (ok.current ? { exitCode: 0, stdout: JSON.stringify(TOUR) } : { exitCode: 1, stdout: '' }) })
  await s.hud('lots')
  await settle()
  ok.current = false
  await s.advance(60_000)
  expect(s.tours().length).toBeGreaterThan(1)
  const d = await s.draw()
  expect(d.text).toContain('L401')
  expect(d.text).not.toContain('Lots illisibles')
})

test('R7 — un projet en erreur dans le panneau : son message, les autres projets présents', async ($, on) => {
  const rows = [{ project: 'cassé', error: 'raf.yaml ligne 12 : YAML invalide', doing: [], drift: [], notes: [], next: null, repo: [], progress: { done: 0, doing: 0, todo: 0, added7: 0 } }, ...TOUR]
  const s = await session($, on, { tour: () => ({ exitCode: 0, stdout: JSON.stringify(rows) }) })
  await s.hud('lots')
  await settle()
  const d = await s.draw()
  expect(d.text).toContain('illisible : raf.yaml ligne 12 : YAML invalide')
  expect(d.text).toContain('L401')
})

const FOOTER_STATES: [string, () => Cadence][] = [
  ['vide', () => ({ exitCode: 0, stdout: '[]' })],
  ['erreur', () => ({ exitCode: 127, stdout: '' })],
  ['cadence trop ancien', () => ({ exitCode: 0, stdout: JSON.stringify([{ project: 'a', progress: {} }]) })],
  ['chargé', () => ({ exitCode: 0, stdout: JSON.stringify(TOUR) })],
]
for (const [state, tour] of FOOTER_STATES) {
  test(`R16 — le pied rappelle la commande dans l’état ${state}`, async ($, on) => {
    const s = await session($, on, { tour })
    await s.hud('lots')
    await settle()
    expect((await s.draw()).text).toContain(CLOSE_HELP)
  })
}

test('R17 — le panneau coupe l’arbre à la hauteur du corps : « … +N lots de plus »', async ($, on) => {
  const many = row('p', Array.from({ length: 12 }, (_, i) => lot(`L${i + 1}`)))
  const s = await session($, on, { tour: () => ({ exitCode: 0, stdout: JSON.stringify([many]) }) })
  await s.hud('lots')
  await settle()
  const d = await s.draw(70, 6)
  expect(d.text).toContain('… +10 lots de plus')
  expect(d.text).toContain(CLOSE_HELP)
})

test('R13 — dossier de la vague retenu avant celui de la session', async ($, on) => {
  const s = await session($, on, { waves: [WAVE] })
  await s.hud('lots')
  await settle()
  expect(s.tours()[0]).toEqual(['cadence', 'lead', 'tour', '/p', '--json'])
})

test('R13 — sans vague, le dossier de la session', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await settle()
  expect(s.tours()[0]).toEqual(['cadence', 'lead', 'tour', '/x', '--json'])
})

test('R12 — transition de vague : relecture', async ($, on) => {
  const s = await session($, on, { waves: [WAVE] })
  await s.hud('lots')
  await settle()
  const before = s.tours().length
  s.waves.current = [{ ...WAVE, lots: WAVE.lots.map(l => ({ ...l, status: 'ready' })) }]
  await s.advance(5_000)
  expect(s.tours().length).toBe(before + 1)
})

test('R12 — plan modifié : relecture avant la minute', async ($, on) => {
  const mtime = { current: 1 }
  const s = await session($, on, { stamps: () => JSON.stringify({ '/x/a/.cadence/raf.yaml': mtime.current }) })
  await s.hud('lots')
  await settle()
  const before = s.tours().length
  mtime.current = 2
  await s.advance(5_000)
  expect(s.tours().length).toBe(before + 1)
})

test('R12 — rien de changé : pas de relecture', async ($, on) => {
  const s = await session($, on, { stamps: () => JSON.stringify({ '/x/a/.cadence/raf.yaml': 1 }) })
  await s.hud('lots')
  await settle()
  const before = s.tours().length
  await s.advance(5_000)
  await s.advance(5_000)
  expect(s.tours().length).toBe(before)
  await s.advance(60_000)
  expect(s.tours().length).toBe(before + 1)
})

test('R12 — panneau fermé : aucune date de plan n’est lue', async ($, on) => {
  const s = await session($, on)
  await s.advance(5_000)
  expect(s.runs.filter(a => a[3] === PLAN_STAMPS)).toEqual([])
})
