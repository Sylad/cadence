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
const session = async ($: Parameters<TestBody>[0], on: On, setup: { tour?: () => Cadence | Promise<Cadence>; waves?: Wave[]; stamps?: () => string; refuse?: string; kv?: [string, unknown][]; raf?: (argv: string[], cwd: string | undefined) => { exitCode: number; stderr: string } } = {}) => {
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
  const kv = new Map<string, unknown>(setup.kv ?? [])
  on('store.get', (_$, e) => ({ value: kv.get(e.key) }) as never)
  on('store.set', (_$, e) => {
    kv.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.open', (_$, e) => {
    opened.push(e)
    if (setup.refuse !== undefined) return { value: { isPlaced: false, reason: setup.refuse } } as never
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
    if (argv[0] === 'raf') {
      const r = (setup.raf ?? (() => ({ exitCode: 0, stderr: '' })))(argv, (e as unknown as { init?: { cwd?: string } }).init?.cwd)
      return { value: { exitCode: r.exitCode, stdout: '', stderr: r.stderr } } as never
    }
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
  /** Les textes du panneau monté, ceux que dessinent les régions Client (un projet chacune) comprises. */
  const textsOf = async (ui: Awaited<ReturnType<typeof $.ui.mount>>) => {
    await ui.drawn() // le dessin suit les écritures d'état avant la lecture
    const own = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
    const regions = await Promise.all((await ui.findAll({ type: 'Client' })).map(async c => (await ui.findAll({ type: 'Text', in: c.key } as never)).map(t => t.text ?? '')))
    return [...own, ...regions.flat()]
  }
  const draw = async (bodyColumns = 70, bodyRows = 30) => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'Pane',
      requestId: 'lots',
      props: { title: 'Lots', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
    } as never)
    const texts = await textsOf(ui)
    const buttons = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    return { texts, text: [...buttons.map(b => b.text ?? ''), ...texts].join('\n'), buttons }
  }
  /** Appuie sur un Button du panneau par sa clé, puis laisse se poser le travail lancé. */
  const pressKey = async (key: string) => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'Pane',
      requestId: 'lots',
      props: { title: 'Lots', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    } as never)
    await ui.press({ key })
    await ui.unmount()
    await settle()
  }
  /** Appuie sur le Button du projet (clic, ou Entrée sous le focus : même appui). */
  const press = async (project: string) => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'Pane',
      requestId: 'lots',
      props: { title: 'Lots', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    } as never)
    await ui.press({ key: `fold:${project}` })
    await ui.unmount()
    await settle()
  }
  const rafs = () => runs.filter(a => a[0] === 'raf')
  /** Joue des gestes sur le panneau monté, comme la personne : chaque région Client reçoit sa taille, puis `act` ; rend le texte dessiné à la fin. */
  const gestures = async (act: (ui: Awaited<ReturnType<typeof $.ui.mount>>) => Promise<void>, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' = 'desktop') => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: 'lots',
      props: { title: 'Lots', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    } as never)
    if (surface === 'desktop' || surface === 'terminal') await ui.resize({ columns: 70, rows: 4, in: 'lots:cadence' } as never)
    await act(ui)
    await settle()
    // le montage ne suit pas les écritures d'état (comme `press`, qui remonte pour relire) : le résultat est lu sur un montage neuf, les régions Client sur celui des gestes
    const live = await textsOf(ui)
    await ui.unmount()
    const fresh = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: 'lots',
      props: { title: 'Lots', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    } as never)
    const text = [...live, ...(await textsOf(fresh))].join('\n')
    await fresh.unmount()
    return text
  }
  return { rafs, gestures, kv, press, pressKey, store, open, opened, runs, tours, tour, stamps, waves, hud, advance, draw }
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

test('R19 — à 60 colonnes la commande ouvre quand même le panneau : le moteur le place', async ($, on) => {
  const s = await session($, on)
  expect((await s.hud('lots', 60)).text).toMatch(/ouvert/)
  expect(s.opened).toMatchObject([{ id: 'lots', title: 'Lots' }])
  expect(s.open.has('lots')).toBe(true)
})

test('R19 — le moteur ne place pas le panneau : la commande donne sa raison, rien n’est ouvert', async ($, on) => {
  const s = await session($, on, { refuse: 'pas de place' })
  expect((await s.hud('lots', 140)).text).toBe('panneau des lots non placé : pas de place')
  expect(s.open.has('lots')).toBe(false)
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
  const s = await session($, on, { kv: [['lotsViews', { 'open:cadence#L401': true }]] })
  await s.hud('lots')
  await settle()
  const d = await s.draw()
  expect(d.buttons.map(b => b.text)).toEqual(['▾ cadence', ' ▾L401', '▾ ol'])
  expect(d.texts.some(t => /^\s*2 lots non clos$/.test(t))).toBe(true)
  expect(d.texts.some(t => /^\s*1 lot non clos$/.test(t))).toBe(true)
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

test('R8 — les lots n’ont pas de bouton (leur région Client réordonne), seuls les noms de projet se replient (L409, L402)', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await settle()
  const d = await s.draw()
  expect(d.buttons.map(b => b.key)).toEqual(['fold:cadence', 'fold:ol'])
  expect(d.text).toContain('glisser un lot, ou Alt+↑ / Alt+↓')
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
  const s = await session($, on, { tour: () => ({ exitCode: 0, stdout: JSON.stringify([many]) }), kv: [['lotsViews', { 'more:p': true }]] })
  await s.hud('lots')
  await settle()
  const d = await s.draw(70, 6)
  expect(d.text).toContain('… +11 lots de plus')
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

// ── L409 : replier / déplier un projet ─────────────────────────────────────────────────────────────────────────────

const big = row('maritime', Array.from({ length: 25 }, (_, i) => lot(`M${i + 1}`, i === 0 ? 'doing' : 'todo')))
const OPEN_BIG: [string, unknown][] = [['lotsViews', { 'more:maritime': true }]]
const BIG_TOUR = () => ({ exitCode: 0, stdout: JSON.stringify([big, ...TOUR]) })

test('R1 — le panneau montre maritime (25 lots) replié, les autres projets déployés', async ($, on) => {
  const s = await session($, on, { tour: BIG_TOUR })
  await s.hud('lots')
  const { text } = await s.draw()
  expect(text).toMatch(/▸ maritime/)
  expect(text).toMatch(/25 lots non clos · 1 en cours/)
  expect(text).not.toMatch(/M2\b/)
  expect(text).toMatch(/▾ ol/)
  expect(text).toMatch(/L80/)
})

test('R5 — l’appui sur le nom du projet le déplie, un second le replie', async ($, on) => {
  const s = await session($, on, { tour: BIG_TOUR, kv: OPEN_BIG })
  await s.hud('lots')
  expect((await s.draw()).buttons.map(b => b.key)).toContain('fold:maritime')
  await s.press('maritime')
  const open = await s.draw(70, 80)
  expect(open.text).toMatch(/▾ maritime/)
  expect(open.text).toMatch(/M25/)
  await s.press('maritime')
  expect((await s.draw()).text).not.toMatch(/M25/)
})

test('R6 — l’état est gardé : fermer puis rouvrir le panneau, et une nouvelle session, le retrouvent', async ($, on) => {
  const s = await session($, on, { tour: BIG_TOUR, kv: OPEN_BIG })
  await s.hud('lots')
  await s.draw()
  await s.press('maritime')
  expect(s.kv.get('lotsFolds')).toEqual({ maritime: false })
  await s.hud('lots')
  await s.hud('lots')
  expect((await s.draw(70, 80)).text).toMatch(/M25/)
})

test('R6 — une nouvelle session relit le choix gardé', async ($, on) => {
  const s = await session($, on, { tour: BIG_TOUR, kv: [['lotsFolds', { maritime: false, ol: true }], ...OPEN_BIG] })
  await s.hud('lots')
  const { text } = await s.draw(70, 80)
  expect(text).toMatch(/M25/)
  expect(text).toMatch(/▸ ol/)
  expect(text).not.toMatch(/L80/)
})

test('R7 — /hud lots <projet> bascule le projet au clavier ; un nom inconnu est dit', async ($, on) => {
  const s = await session($, on, { tour: BIG_TOUR, kv: OPEN_BIG })
  await s.hud('lots')
  await s.draw()
  expect((await s.hud('lots maritime')).text).toBe('maritime déplié.')
  expect((await s.draw(70, 80)).text).toMatch(/M25/)
  expect((await s.hud('lots maritime')).text).toBe('maritime replié.')
  expect((await s.hud('lots nimporte')).text).toBe('projet inconnu : nimporte (projets : maritime, cadence, ol)')
})

test('R7 — /hud lots <projet> avant la première lecture : « pas encore lu », pas « projet inconnu »', async ($, on) => {
  const s = await session($, on, { tour: () => new Promise(() => undefined) })
  const text = (await s.hud('lots maritime')).text
  expect(text).toMatch(/pas encore lus/)
  expect(text).not.toMatch(/inconnu/)
})

// ── L411 : cinq lots par projet, sous-lots repliés, états gardés ───────────────────────────────────────────────────

const ten = row('dix', Array.from({ length: 10 }, (_, i) => lot(`D${i + 1}`)))
const TEN_TOUR = () => ({ exitCode: 0, stdout: JSON.stringify([ten, ...TOUR]) })

test('R1 — le panneau montre cinq lots d’un projet de dix et le bouton « + 5 lots »', async ($, on) => {
  const s = await session($, on, { tour: TEN_TOUR })
  await s.hud('lots')
  const { text, buttons } = await s.draw(70, 80)
  expect(text).toMatch(/D5\b/)
  expect(text).not.toMatch(/D6\b/)
  expect(text).toMatch(/\+ 5 lots/)
  expect(buttons.map(b => b.key)).toContain('more:dix')
})

test('R2 — l’appui sur « + 5 lots » montre le reste, « moins » le replie', async ($, on) => {
  const s = await session($, on, { tour: TEN_TOUR })
  await s.hud('lots')
  await s.draw()
  await s.pressKey('more:dix')
  const open = await s.draw(70, 80)
  expect(open.text).toMatch(/D10\b/)
  expect(open.text).toMatch(/moins/)
  expect(open.text).not.toMatch(/\+ 5 lots/)
  await s.pressKey('more:dix')
  expect((await s.draw(70, 80)).text).not.toMatch(/D10\b/)
})

test('R3 — un lot à sous-lots : replié avec son compte, un appui le déplie, un second le replie', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  const closed = await s.draw()
  expect(closed.buttons.map(b => b.key)).toContain('open:cadence#L401')
  expect(closed.text).toMatch(/ ▸L401/)
  expect(closed.text).toMatch(/2 sous-lots/)
  expect(closed.text).not.toMatch(/L401\/2/)
  await s.pressKey('open:cadence#L401')
  const open = await s.draw()
  expect(open.text).toMatch(/ ▾L401/)
  expect(open.text).toMatch(/L401\/2/)
  await s.pressKey('open:cadence#L401')
  expect((await s.draw()).text).not.toMatch(/L401\/2/)
})

test('R4 — les états sont gardés : dans le magasin, après fermeture/réouverture et dans une nouvelle session', async ($, on) => {
  const s = await session($, on, { tour: TEN_TOUR })
  await s.hud('lots')
  await s.draw()
  await s.pressKey('more:dix')
  await s.pressKey('open:cadence#L401')
  expect(s.kv.get('lotsViews')).toEqual({ 'more:dix': true, 'open:cadence#L401': true })
  await s.hud('lots')
  await s.hud('lots')
  const text = (await s.draw(70, 80)).text
  expect(text).toMatch(/D10\b/)
  expect(text).toMatch(/L401\/2/)
})

test('R4 — une nouvelle session relit les états gardés ; un magasin illisible laisse les défauts', async ($, on) => {
  const kept = await session($, on, { tour: TEN_TOUR, kv: [['lotsViews', { 'more:dix': true, 'open:cadence#L401': 'oui' }]] })
  await kept.hud('lots')
  const text = (await kept.draw(70, 80)).text
  expect(text).toMatch(/D10\b/)
  expect(text).not.toMatch(/L401\/2/)

// ── L402 : réordonner dans le panneau ─────────────────────────────────────────────────────────────────────────

// lignes du projet « cadence » de TOUR, dans la région Client : L401 (y 0), L401/1 (1), L401/2 (2), L402 (3)
const down = (y: number) => ({ type: 'down', x: 4, y, button: 'left', in: 'lots:cadence' }) as never
const move = (y: number) => ({ type: 'move', x: 4, y, button: 'left', in: 'lots:cadence' }) as never
const up = (y: number) => ({ type: 'up', x: 4, y, button: 'left', in: 'lots:cadence' }) as never
const altKey = (key: 'up' | 'down') => ({ key, meta: true, in: 'lots:cadence' }) as never

test('R22 — glisser un lot sur un autre : raf move dans le projet, puis le panneau se relit et dit que le plan est à commiter', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  const before = s.tours().length
  const text = await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(move(0))
    await ui.pointer(up(0))
  })
  expect(s.rafs()).toEqual([['raf', 'move', 'L402', '--before', 'L401']])
  expect(s.tours().length).toBe(before + 1)
  expect(text).toMatch(/L402 placé avant L401 — le plan est modifié, à commiter/)
})

test('R22 — le dossier de raf est celui du projet', async ($, on) => {
  const cwds: (string | undefined)[] = []
  const s = await session($, on, { raf: (_argv, cwd) => (cwds.push(cwd), { exitCode: 0, stderr: '' }) })
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(up(0))
  })
  expect(cwds).toEqual(['/x/cadence'])
})

test('R22 — glisser vers le bas place après la cible', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.pointer(down(0))
    await ui.pointer(up(3))
  })
  expect(s.rafs()).toEqual([['raf', 'move', 'L401', '--after', 'L402']])
})

test('R22 — pendant le glisser, un repère marque la position d’arrivée ; relâché au même endroit, rien ne bouge', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  const during = await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(move(0))
  })
  expect(during).toMatch(/⇡/)
  const still = await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(move(0))
    await ui.pointer(move(3))
    await ui.pointer(up(3))
  })
  expect(still).not.toMatch(/⇡/)
  expect(s.rafs()).toEqual([])
})

test('R22 — au clavier : sélection, puis Alt+↑ / Alt+↓ place le lot avant le précédent / après le suivant (les sous-tâches du lot voisin ne comptent pas)', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(up(3))
    await ui.key(altKey('up'))
  })
  await s.gestures(async ui => {
    await ui.pointer(down(0))
    await ui.pointer(up(0))
    await ui.key(altKey('down'))
  })
  expect(s.rafs()).toEqual([['raf', 'move', 'L402', '--before', 'L401'], ['raf', 'move', 'L401', '--after', 'L402']])
})

test('R22 — au clavier, ↑ / ↓ seuls changent la sélection ; rien sans sélection ; aux bords rien ne part', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.key(altKey('up'))
    await ui.key({ key: 'down', in: 'lots:cadence' } as never)
    await ui.key({ key: 'down', in: 'lots:cadence' } as never)
    await ui.key({ key: 'down', in: 'lots:cadence' } as never)
    await ui.key({ key: 'down', in: 'lots:cadence' } as never)
    await ui.key(altKey('down'))
  })
  expect(s.rafs()).toEqual([])
})

test('R22 — une sous-tâche se réordonne par glisser parmi celles de son lot', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.pointer(down(2))
    await ui.pointer(up(1))
  })
  expect(s.rafs()).toEqual([['raf', 'move', 'L401/2', '--before', 'L401/1']])
})

test('R23 — parents différents : refusé avec sa raison, raf n’est pas appelé et le tableau n’est pas relu', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  const before = s.tours().length
  const text = await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(up(2))
  })
  expect(s.rafs()).toEqual([])
  expect(text).toMatch(/L402 et L401\/2 n'ont pas le même parent/)
  expect(s.tours().length).toBe(before)
})

for (const reason of ['move : orchestration en cours (vague w1, pid 3) — attendre', 'plan en lecture seule : maritime — le modifier avec l’outil du projet', 'move : L402 est archivé']) {
  test(`R23 — un refus de raf est montré avec sa raison, sans relecture : ${reason.split(' — ')[0]}`, async ($, on) => {
    const s = await session($, on, { raf: () => ({ exitCode: 2, stderr: `raf: ${reason}\n` }) })
    await s.hud('lots')
    const before = s.tours().length
    const text = await s.gestures(async ui => {
      await ui.pointer(down(3))
      await ui.pointer(up(0))
    })
    expect(text).toContain(reason)
    expect(text).not.toMatch(/à commiter/)
    expect(s.tours().length).toBe(before)
  })
}

test('R23 — raf introuvable : le panneau le dit', async ($, on) => {
  const s = await session($, on, { raf: () => { throw new Error('ENOENT') } })
  await s.hud('lots')
  const text = await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(up(0))
  })
  expect(text).toMatch(/raf move n’a pas pu être lancé/)
})

test('R22 — une demande forgée (projet ou lot inconnu) est ignorée', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.post({ kind: 'move', project: 'zzz', id: 'L402', target: 'L401', place: 'before' }, { in: 'lots:cadence' } as never)
    await ui.post({ kind: 'move', project: 'cadence', id: 'L402', target: 'L9', place: 'before' }, { in: 'lots:cadence' } as never)
    await ui.post('n’importe quoi', { in: 'lots:cadence' } as never)
  })
  expect(s.rafs()).toEqual([])
})

test('R22 — sur une surface sans Client (mobile, éditeur) le panneau se dessine, sans glisser', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  for (const surface of ['mobile', 'vscode'] as const) expect(await s.gestures(async () => undefined, surface)).toContain('L402')
})

test('R22 — le clavier fonctionne aussi dans le terminal', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(up(3))
    await ui.key(altKey('up'))
  }, 'terminal')
  expect(s.rafs()).toEqual([['raf', 'move', 'L402', '--before', 'L401']])
})

test('R23 — pendant le glisser, un repère dit qu’une arrivée chez un autre parent sera refusée', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  const during = await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(move(2))
  })
  expect(during).toMatch(/⊘/)
  expect(during).not.toMatch(/⇡/)
})
