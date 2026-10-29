import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'

import { DELIVERIES, PLAN_STAMPS } from '../hooks/collect'
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
const session = async ($: Parameters<TestBody>[0], on: On, setup: { tour?: () => Cadence | Promise<Cadence>; waves?: Wave[]; stamps?: () => string; deliveries?: () => string; refuse?: string; kv?: [string, unknown][]; raf?: (argv: string[], cwd: string | undefined) => { exitCode: number; stderr: string } } = {}) => {
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
    if (argv[3] === DELIVERIES) return { value: { exitCode: 0, stdout: (setup.deliveries ?? (() => '[]'))(), stderr: '' } } as never
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
  /** Monte le panneau des lots : le seul endroit qui appelle `$.ui.mount`. */
  const mountPane = (surface: 'terminal' | 'desktop' | 'mobile' | 'vscode', isFocused: boolean, bodyColumns: number, bodyRows: number): Promise<Mounted<'desktop' | 'terminal', 'Pane'>> =>
    $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: 'lots',
      props: { title: 'Lots', isFocused, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
    } as never) as never
  /** Les textes du panneau monté, ceux que dessinent les régions Client (un projet chacune) comprises. */
  const textsOf = async (ui: Pick<Mounted<'desktop' | 'terminal', 'Pane'>, 'drawn' | 'findAll'>) => {
    await ui.drawn() // le dessin suit les écritures d'état avant la lecture
    const own = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
    const regions = await Promise.all((await ui.findAll({ type: 'Client' })).map(async c => (await ui.findAll({ type: 'Text', in: c.key } as never)).map(t => t.text ?? '')))
    return [...own, ...regions.flat()]
  }
  const draw = async (bodyColumns = 70, bodyRows = 30, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' = 'terminal') => {
    const ui = await mountPane(surface, false, bodyColumns, bodyRows)
    const texts = await textsOf(ui)
    const buttons = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    return { texts, text: [...buttons.map(b => b.text ?? ''), ...texts].join('\n'), buttons }
  }
  /** Appuie sur un Button du panneau par sa clé, puis laisse se poser le travail lancé (la bascule d'un lot à sous-lots n'est un Button que sur une surface sans région Client : `mobile`). */
  const pressKey = async (key: string, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' = 'terminal') => {
    const ui = await mountPane(surface, false, 70, 60)
    await ui.press({ key })
    await ui.unmount()
    await settle()
  }
  /** Appuie sur le Button du projet (clic, ou Entrée sous le focus : même appui). */
  const press = async (project: string) => {
    const ui = await mountPane('terminal', false, 70, 60)
    await ui.press({ key: `fold:${project}` })
    await ui.unmount()
    await settle()
  }
  const rafs = () => runs.filter(a => a[0] === 'raf')
  /** Le dernier mot du panneau sur un déplacement, lu sur un montage neuf (le texte de `gestures` porte aussi celui d'avant, sur le montage des gestes). */
  const notice = async () => (await draw()).texts.find(t => /^[✔•✖] /.test(t))
  /** Joue des gestes sur le panneau monté, comme la personne : chaque région Client reçoit sa taille (`rows` : les lignes du projet « cadence »), puis `act` ; rend le texte dessiné à la fin. */
  const gestures = async (act: (ui: Mounted<'desktop' | 'terminal', 'Pane'>) => Promise<void>, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' = 'desktop', rows = 4, region = 'lots:cadence') => {
    // sans Client (mobile, éditeur) le montage n'a ni pointeur, ni clavier, ni taille : `act` n'y est pas joué, seul le dessin est lu
    const hasClient = surface === 'desktop' || surface === 'terminal'
    const ui = await mountPane(surface, true, 70, 60)
    if (hasClient) {
      await ui.resize({ columns: 70, rows, in: region })
      await act(ui)
    }
    await settle()
    // le montage ne suit pas les écritures d'état (comme `press`, qui remonte pour relire) : le résultat est lu sur un montage neuf, les régions Client sur celui des gestes
    const live = await textsOf(ui)
    await ui.unmount()
    const fresh = await mountPane(surface, true, 70, 60)
    const text = [...live, ...(await textsOf(fresh))].join('\n')
    await fresh.unmount()
    return text
  }
  return { rafs, gestures, notice, kv, press, pressKey, store, open, opened, runs, tours, tour, stamps, waves, hud, advance, draw }
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
  expect(d.buttons.map(b => b.text)).toEqual(['▾ cadence', '▾ ol']) // dans la région Client (terminal), la bascule ▾ d'un lot n'est pas un Button : la région reçoit l'appui (L402 × L411)
  expect(d.text).toContain(' ▾L401')
  expect(d.text).toContain('2 sous-lots')
  const mobile = await s.draw(70, 30, 'mobile')
  expect(mobile.buttons.map(b => b.text)).toEqual(['▾ cadence', ' ▾L401', '▾ ol']) // sans région Client, la bascule est un Button
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
  // le tour est retenu, pas abandonné : un tour qui ne répond jamais reviendrait au délai du mod (20 s), après le déchargement du module, et le fichier de tests finirait sur un rejet sans preneur dès qu'il dure plus de 20 s (sous charge)
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const s = await session($, on, { tour: async () => (await gate, { exitCode: 0, stdout: JSON.stringify(TOUR) }) })
  const text = (await s.hud('lots maritime')).text
  expect(text).toMatch(/pas encore lus/)
  expect(text).not.toMatch(/inconnu/)
  release()
  await settle()
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

test('R3 — un lot à sous-lots : replié avec son compte, un appui le déplie, un second le replie (Button sans région Client : mobile)', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  const closed = await s.draw(70, 30, 'mobile')
  expect(closed.buttons.map(b => b.key)).toContain('open:cadence#L401')
  expect(closed.text).toMatch(/ ▸L401/)
  expect(closed.text).toMatch(/2 sous-lots/)
  expect(closed.text).not.toMatch(/L401\/2/)
  await s.pressKey('open:cadence#L401', 'mobile')
  const open = await s.draw(70, 30, 'mobile')
  expect(open.text).toMatch(/ ▾L401/)
  expect(open.text).toMatch(/L401\/2/)
  await s.pressKey('open:cadence#L401', 'mobile')
  expect((await s.draw(70, 30, 'mobile')).text).not.toMatch(/L401\/2/)
})

test('R3 — dans la région Client (terminal, desktop) : un appui sur la cellule ▸ du lot déplie ses sous-lots, un second la replie ; l’appui sur l’id sélectionne sans déplier', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  const closed = await s.draw()
  expect(closed.buttons.map(b => b.key)).toEqual(['fold:cadence', 'fold:ol'])
  expect(closed.text).toMatch(/ ▸L401/)
  expect(closed.text).not.toMatch(/L401\/2/)
  // la région « cadence » replié : L401 (y 0), L402 (1) ; la bascule de L401 est la cellule x 1 (« ␣▸L401 »)
  await s.gestures(async ui => {
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'lots:cadence' } as never)
    await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'lots:cadence' } as never)
  }, 'terminal', 2)
  const open = await s.draw()
  expect(open.text).toMatch(/ ▾L401/)
  expect(open.text).toMatch(/L401\/2/)
  expect(s.kv.get('lotsViews')).toEqual({ 'open:cadence#L401': true })
  // un appui sur l'id (x 4) sélectionne la ligne, ne replie rien ; un relâché sur place ne déplace rien
  await s.gestures(async ui => {
    await ui.pointer(down(0))
    await ui.pointer(up(0))
  }, 'terminal', 4)
  expect((await s.draw()).text).toMatch(/L401\/2/)
  expect(s.rafs()).toEqual([])
  // ré-appui sur la bascule : replié
  await s.gestures(async ui => {
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'lots:cadence' } as never)
    await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: 'lots:cadence' } as never)
  }, 'terminal', 4)
  expect((await s.draw()).text).not.toMatch(/L401\/2/)
  expect(s.kv.get('lotsViews')).toEqual({ 'open:cadence#L401': false })
})

test('R3 — dans la région Client : Entrée sur la ligne sélectionnée bascule ses sous-lots ; rien sur un lot sans sous-lot ; une bascule forgée est ignorée', async ($, on) => {
  const s = await session($, on)
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.pointer(down(0)) // L401, sélectionné
    await ui.pointer(up(0))
    await ui.key({ key: 'return', in: 'lots:cadence' } as never)
  }, 'desktop', 2)
  expect((await s.draw()).text).toMatch(/L401\/2/)
  await s.gestures(async ui => {
    await ui.pointer(down(3)) // L402, sans sous-lot
    await ui.pointer(up(3))
    await ui.key({ key: 'return', in: 'lots:cadence' } as never)
    await ui.post({ kind: 'toggle', project: 'cadence', key: 'open:cadence#L999' }, { in: 'lots:cadence' } as never)
    await ui.post({ kind: 'toggle', project: 'zzz', key: 'open:cadence#L401' }, { in: 'lots:cadence' } as never)
  }, 'desktop', 4)
  expect(s.kv.get('lotsViews')).toEqual({ 'open:cadence#L401': true })
  expect(s.rafs()).toEqual([])
})

test('R4 — les états sont gardés : dans le magasin, après fermeture/réouverture et dans une nouvelle session', async ($, on) => {
  const s = await session($, on, { tour: TEN_TOUR })
  await s.hud('lots')
  await s.draw()
  await s.pressKey('more:dix') // le bouton « + N lots » est hors de la région : un Button sur toute surface
  await s.pressKey('open:cadence#L401', 'mobile')
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
})

// ── L402 : réordonner dans le panneau ─────────────────────────────────────────────────────────────────────────

// lignes du projet « cadence » de TOUR, dans la région Client, L401 déplié (L411 replie les sous-lots par défaut) : L401 (y 0), L401/1 (1), L401/2 (2), L402 (3)
/** Les sous-lots de L401 (TOUR) et de L11 (L410_TOUR) dépliés : les sous-tâches sont des lignes de la région. */
const SUBS_OPEN: [string, unknown][] = [['lotsViews', { 'open:cadence#L401': true, 'open:cadence#L11': true }]]
const down = (y: number) => ({ type: 'down', x: 4, y, button: 'left', in: 'lots:cadence' }) as never
const move = (y: number) => ({ type: 'move', x: 4, y, button: 'left', in: 'lots:cadence' }) as never
const up = (y: number) => ({ type: 'up', x: 4, y, button: 'left', in: 'lots:cadence' }) as never
const altKey = (key: 'up' | 'down') => ({ key, meta: true, in: 'lots:cadence' }) as never
/** Le tableau des gestes qui doivent partir : les lots et sous-tâches de TOUR tous EN COURS, donc d'un même groupe d'affichage (L410) ; mêmes lignes que TOUR (L401 y 0, L401/1 y 1, L401/2 y 2, L402 y 3). */
const MOVE_TOUR = JSON.stringify([row('cadence', [lot('L401', 'doing'), lot('L401/1', 'doing', { parent: 'L401' }), lot('L401/2', 'doing', { parent: 'L401' }), lot('L402', 'doing')]), TOUR[1]])
const moves = ($: Parameters<TestBody>[0], on: On, setup: Parameters<typeof session>[2] = {}) => session($, on, { kv: SUBS_OPEN, tour: () => ({ exitCode: 0, stdout: MOVE_TOUR }), ...setup })

test('R22 — glisser un lot sur un autre : raf move dans le projet, puis le panneau se relit et dit que le plan est à commiter', async ($, on) => {
  const s = await moves($, on)
  await s.hud('lots')
  const before = s.tours().length
  const text = await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(move(0))
    await ui.pointer(up(0))
  })
  expect(s.rafs()).toEqual([['raf', 'move', 'L402', '--before', 'L401']])
  expect(s.tours().length).toBe(before + 1)
  expect(text).toMatch(/✔ L402 placé avant L401 — le plan est modifié, à commiter \(raf move ne commite pas\)$/m)
  expect(text).not.toMatch(/rien ne bouge/) // le message « à l'écran rien ne bouge » n'existe plus : un geste ne part que dans un groupe, où l'écran suit le plan
})

test('R22 — le dossier de raf est celui du projet', async ($, on) => {
  const cwds: (string | undefined)[] = []
  const s = await moves($, on, { raf: (_argv, cwd) => (cwds.push(cwd), { exitCode: 0, stderr: '' }) })
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(up(0))
  })
  expect(cwds).toEqual(['/x/cadence'])
})

test('R22 — glisser vers le bas place après la cible', async ($, on) => {
  const s = await moves($, on)
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.pointer(down(0))
    await ui.pointer(up(3))
  })
  expect(s.rafs()).toEqual([['raf', 'move', 'L401', '--after', 'L402']])
})

test('R22 — pendant le glisser, un repère marque la position d’arrivée ; relâché au même endroit, rien ne bouge', async ($, on) => {
  const s = await moves($, on)
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
  const s = await moves($, on)
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
  const s = await moves($, on)
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
  const s = await moves($, on)
  await s.hud('lots')
  const text = await s.gestures(async ui => {
    await ui.pointer(down(2))
    await ui.pointer(up(1))
  })
  expect(s.rafs()).toEqual([['raf', 'move', 'L401/2', '--before', 'L401/1']])
  expect(text).toMatch(/L401\/2 placé avant L401\/1 — le plan est modifié, à commiter/)
})

test('R23 — parents différents : refusé avec sa raison, raf n’est pas appelé et le tableau n’est pas relu', async ($, on) => {
  const s = await moves($, on)
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

for (const reason of ['move : orchestration en cours (vague w1, pid 3) — attendre', 'plan en lecture seule : /repo/plan-maritime.json est tenu par un autre outil (cadence.yaml : plan) — le modifier avec l’outil du projet', 'move : L402 est archivé']) {
  test(`R23 — un refus de raf est montré avec sa raison, sans relecture : ${reason.split(' — ')[0]}`, async ($, on) => {
    const s = await moves($, on, { raf: () => ({ exitCode: 2, stderr: `raf: ${reason}\n` }) })
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
  const s = await moves($, on, { raf: () => { throw new Error('ENOENT') } })
  await s.hud('lots')
  const text = await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(up(0))
  })
  expect(text).toMatch(/raf move n’a pas pu être lancé/)
})

test('R22 — une demande forgée (projet ou lot inconnu) est ignorée', async ($, on) => {
  const s = await moves($, on)
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.post({ kind: 'move', project: 'zzz', id: 'L402', target: 'L401', place: 'before' }, { in: 'lots:cadence' } as never)
    await ui.post({ kind: 'move', project: 'cadence', id: 'L402', target: 'L9', place: 'before' }, { in: 'lots:cadence' } as never)
    await ui.post('n’importe quoi', { in: 'lots:cadence' } as never)
  })
  expect(s.rafs()).toEqual([])
})

test('R22 — sur une surface sans Client (mobile, éditeur) le panneau se dessine, sans glisser', async ($, on) => {
  const s = await moves($, on)
  await s.hud('lots')
  for (const surface of ['mobile', 'vscode'] as const) expect(await s.gestures(async () => undefined, surface)).toContain('L402')
})

test('R22 — le clavier fonctionne aussi dans le terminal', async ($, on) => {
  const s = await moves($, on)
  await s.hud('lots')
  await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(up(3))
    await ui.key(altKey('up'))
  }, 'terminal')
  expect(s.rafs()).toEqual([['raf', 'move', 'L402', '--before', 'L401']])
})

test('R23 — pendant le glisser, un repère dit qu’une arrivée chez un autre parent sera refusée', async ($, on) => {
  const s = await moves($, on)
  await s.hud('lots')
  const during = await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(move(2))
  })
  expect(during).toMatch(/⊘/)
  expect(during).not.toMatch(/⇡/)
})

// ── L402 : les props arrivent pendant un glisser (relecture du tableau, minuteur de 5 s) ─────────────────────

/** Le tableau de TOUR, un lot EN COURS de plus en tête du projet « cadence » : l'ordre d'affichage (L410) met les lots en cours d'abord, dans l'ordre du plan ; L400 prend donc la ligne 0 à l'écran, et L402, saisi à la ligne 3, passe à la ligne 4. (Un lot seulement « à faire » se rangerait après L401, en cours, et la ligne 0 resterait L401.) */
const TOUR_WITH_L400_FIRST = JSON.stringify([row('cadence', [lot('L400', 'doing'), ...JSON.parse(MOVE_TOUR)[0].lots]), TOUR[1]])
/** Le tableau de TOUR sans L402 : le lot saisi à la ligne 3 a disparu. */
const TOUR_WITHOUT_L402 = JSON.stringify([row('cadence', JSON.parse(MOVE_TOUR)[0].lots.filter((l: { id: string }) => l.id !== 'L402')), TOUR[1]])

test('R22 — de nouvelles props pendant un glisser : c’est le lot saisi qui part, pas celui qui prend sa ligne', async ($, on) => {
  const s = await moves($, on)
  await s.hud('lots')
  const before = s.tours().length
  await s.gestures(async ui => {
    await ui.pointer(down(3)) // L402
    s.tour.current = () => ({ exitCode: 0, stdout: TOUR_WITH_L400_FIRST })
    s.stamps.current = () => JSON.stringify({ '/x/cadence/.cadence/raf.yaml': 2 }) // le plan a changé : le prochain tour du minuteur relit le tableau
    await s.advance(5_000) // L400 prend la tête, L402 passe à la ligne 4, la ligne 3 est maintenant L401/2
    await ui.redraw() // le panneau monté reçoit les nouvelles lignes (comme le moteur, quand les props changent)
    await ui.pointer(move(0))
    await ui.pointer(up(0))
  })
  expect(s.tours().length).toBeGreaterThan(before) // le tableau a bien été relu pendant le glisser
  expect(s.rafs()).toEqual([['raf', 'move', 'L402', '--before', 'L400']])
})

test('R22 — le lot saisi disparaît pendant le glisser : rien n’est demandé, ni refus ni relecture', async ($, on) => {
  const s = await moves($, on)
  await s.hud('lots')
  const before = s.tours().length
  const text = await s.gestures(async ui => {
    await ui.pointer(down(3)) // L402, encore là
    s.tour.current = () => ({ exitCode: 0, stdout: TOUR_WITHOUT_L402 })
    s.stamps.current = () => JSON.stringify({ '/x/cadence/.cadence/raf.yaml': 2 })
    await s.advance(5_000)
    await ui.redraw()
    await ui.pointer(move(0))
    await ui.pointer(up(0))
  })
  expect(s.tours().length).toBeGreaterThan(before)
  expect(s.rafs()).toEqual([])
  expect(text).not.toMatch(/placé|n'ont pas le même parent|raf move/)
})

// ── L402 : un lot ne se réordonne qu'à l'intérieur de son groupe d'affichage (L410 : en cours, libres, bloqués) ──────────────────

// TOUR : L401 est en cours (y 0), L402 bloqué par L400/L401 (y 3) ; leurs sous-tâches entre les deux.
test('R24 — lâcher un lot sur un lot d’un autre groupe est refusé sans appeler raf, avec la raison par groupe', async ($, on) => {
  const s = await session($, on, { kv: SUBS_OPEN })
  await s.hud('lots')
  const before = s.tours().length
  const text = await s.gestures(async ui => {
    await ui.pointer(down(3)) // L402 (bloqué)
    await ui.pointer(up(0)) // L401 (en cours)
  })
  expect(s.rafs()).toEqual([])
  expect(text).toMatch(/✖ L401 est en cours : un lot bloqué se range parmi les bloqués/)
  expect(s.tours().length).toBe(before)
})

test('R24 — pendant le glisser, le repère ⊘ rouge marque la cible d’un autre groupe, comme celle d’un autre parent', async ($, on) => {
  const s = await session($, on, { kv: SUBS_OPEN })
  await s.hud('lots')
  const during = await s.gestures(async ui => {
    await ui.pointer(down(3))
    await ui.pointer(move(0))
  })
  expect(during).toMatch(/⊘/)
  expect(during).not.toMatch(/⇡/)
})

test('R24 — Alt+↑ vers le voisin affiché d’un autre groupe : même refus, sans appeler raf', async ($, on) => {
  const s = await session($, on, { kv: SUBS_OPEN })
  await s.hud('lots')
  const text = await s.gestures(async ui => {
    await ui.pointer(down(3)) // L402 (bloqué) ; son voisin du dessus affiché, L401 (en cours), saute ses sous-tâches
    await ui.pointer(up(3))
    await ui.key(altKey('up'))
  })
  expect(s.rafs()).toEqual([])
  expect(text).toMatch(/✖ L401 est en cours : un lot bloqué se range parmi les bloqués/)
})

// Le cas vécu (29-10) : le plan L402 L403 L407 L411 (+ trois autres libres), L402 et L411 en cours. À l'écran : L402 (y 0), L411 (1), L403 (2), L407 (3), L420 (4), puis « + 2 lots ».
const LIVED_TOUR = JSON.stringify([row('cadence', [lot('L402', 'doing'), lot('L403'), lot('L407'), lot('L411', 'doing'), lot('L420'), lot('L421'), lot('L422')])])
test('R24 — cas vécu : L403 (libre) lâché sur L411 (en cours) est refusé ; il ne descend pas sous L407 et ne se cache pas derrière « + N lots »', async ($, on) => {
  const s = await session($, on, { tour: () => ({ exitCode: 0, stdout: LIVED_TOUR }) })
  await s.hud('lots')
  const before = s.tours().length
  const text = await s.gestures(async ui => {
    await ui.pointer(down(2)) // L403
    await ui.pointer(up(1)) // L411
  }, 'desktop', 6)
  expect(s.rafs()).toEqual([])
  expect(text).toMatch(/✖ L411 est en cours : un lot libre se range parmi les libres/)
  const last = (id: string) => text.lastIndexOf(id) // le dernier dessin : L403 est toujours avant L407, lui-même avant L420 (rien ne descend derrière « + N lots »)
  expect(last('L403')).toBeGreaterThan(text.lastIndexOf('Lots  glisser'))
  expect(last('L403')).toBeLessThan(last('L407'))
  expect(last('L407')).toBeLessThan(last('L420'))
  expect(s.tours().length).toBe(before)
})

test('R24 — une demande forgée entre deux groupes est refusée aussi : le contrôle est celui du module, pas du dessin', async ($, on) => {
  const s = await session($, on, { tour: () => ({ exitCode: 0, stdout: LIVED_TOUR }) })
  await s.hud('lots')
  const text = await s.gestures(async ui => {
    await ui.post({ kind: 'move', project: 'cadence', id: 'L403', target: 'L411', place: 'after' }, { in: 'lots:cadence' } as never)
  }, 'desktop', 6)
  expect(s.rafs()).toEqual([])
  expect(text).toMatch(/✖ L411 est en cours : un lot libre se range parmi les libres/)
})

// ── L402 × L410 : le lot visé est celui de l'ÉCRAN, pas le voisin du plan ; le panneau dit ce que le geste fait au plan et à l'écran ──

// Le plan : L10 (libre), L11 (en cours ; sous-tâches L11/1 à faire, L11/2 en cours, L11/3 à faire), L12 (bloqué par L10), L13 (libre).
// À l'écran (L410, par état) : L11 (y 0), L11/2 (1), L11/1 (2), L11/3 (3), L10 (4), L13 (5), L12 (6).
// L10, premier du plan, est donc affiché sous L11, qui le suit dans le plan ; L11/2 au-dessus de L11/1, qui la précède dans le plan.
const L410_TOUR = JSON.stringify([row('cadence', [lot('L10'), lot('L11', 'doing'), lot('L11/1', 'todo', { parent: 'L11' }), lot('L11/2', 'doing', { parent: 'L11' }), lot('L11/3', 'todo', { parent: 'L11' }), lot('L12', 'todo', { after: ['L10'] }), lot('L13')])])
const L410_ROWS = 7
const l410 = ($: Parameters<TestBody>[0], on: On) => session($, on, { kv: SUBS_OPEN, tour: () => ({ exitCode: 0, stdout: L410_TOUR }) })

test('R22 — L410 : « déjà » — un lot que le plan place déjà ainsi parmi les lots de son groupe n’appelle pas raf (L11, en cours, sépare L10 et L12 dans le plan)', async ($, on) => {
  const s = await l410($, on)
  await s.hud('lots')
  const before = s.tours().length
  // aucun geste ne mène là (dans un groupe, l'écran suit le plan) : la demande vient d'un dessin forgé
  const text = await s.gestures(async ui => {
    await ui.post({ kind: 'move', project: 'cadence', id: 'L10', target: 'L13', place: 'before' }, { in: 'lots:cadence' } as never)
  }, 'desktop', L410_ROWS)
  expect(s.rafs()).toEqual([])
  expect(text).toMatch(/• L10 est déjà avant L13 dans le plan : rien à déplacer/)
  expect(text).not.toMatch(/à commiter/)
  expect(s.tours().length).toBe(before)
})

test('R22 — L410 : glisser un lot sur un lot du même groupe d’affichage : raf move, et l’écran bouge', async ($, on) => {
  const s = await l410($, on)
  await s.hud('lots')
  const text = await s.gestures(async ui => {
    await ui.pointer(down(5)) // L13 (libre)
    await ui.pointer(up(4)) // L10 (libre) : même groupe, l'écran suivra le plan
  }, 'desktop', L410_ROWS)
  expect(s.rafs()).toEqual([['raf', 'move', 'L13', '--before', 'L10']])
  expect(text).toMatch(/✔ L13 placé avant L10 — le plan est modifié, à commiter \(raf move ne commite pas\)/)
})

test('R24 — L410 : glisser un lot en cours sur un lot bloqué, ou un lot libre sur un lot en cours : refusé, le plan ne bouge pas', async ($, on) => {
  const s = await l410($, on)
  await s.hud('lots')
  const down6 = await s.gestures(async ui => {
    await ui.pointer(down(0)) // L11 (en cours)
    await ui.pointer(up(6)) // L12 (bloqué)
  }, 'desktop', L410_ROWS)
  expect(down6).toMatch(/✖ L12 est bloqué : un lot en cours se range parmi les lots en cours/)
  const up0 = await s.gestures(async ui => {
    await ui.pointer(down(4)) // L10 (libre)
    await ui.pointer(up(0)) // L11 (en cours)
  }, 'desktop', L410_ROWS)
  expect(up0).toMatch(/✖ L11 est en cours : un lot libre se range parmi les libres/)
  expect(s.rafs()).toEqual([])
})

test('R24 — L410 : Alt+↑ / Alt+↓ vont vers le voisin affiché (les sous-tâches du lot voisin ne comptent pas) ; d’un autre groupe, c’est refusé', async ($, on) => {
  const s = await l410($, on)
  await s.hud('lots')
  const moved = await s.gestures(async ui => {
    await ui.pointer(down(5)) // L13 : son voisin du dessus à l'écran est L10, libre comme lui
    await ui.pointer(up(5))
    await ui.key(altKey('up'))
  }, 'desktop', L410_ROWS)
  expect(moved).toMatch(/✔ L13 placé avant L10/)
  const above = await s.gestures(async ui => {
    await ui.pointer(down(4)) // L10 : à l'écran, son voisin du dessus est L11 (sous-tâches sautées), en cours
    await ui.pointer(up(4))
    await ui.key(altKey('up'))
  }, 'desktop', L410_ROWS)
  expect(above).toMatch(/✖ L11 est en cours : un lot libre se range parmi les libres/)
  const below = await s.gestures(async ui => {
    await ui.pointer(down(0)) // L11 : à l'écran, son voisin du dessous est L10 (sous-tâches sautées), libre
    await ui.pointer(up(0))
    await ui.key(altKey('down'))
  }, 'desktop', L410_ROWS)
  expect(below).toMatch(/✖ L10 est libre : un lot en cours se range parmi les lots en cours/)
  expect(s.rafs()).toEqual([['raf', 'move', 'L13', '--before', 'L10']])
})

test('R24 — L410 : entre sous-tâches aussi — dans le groupe, ça part ; d’un groupe à l’autre, refusé avec « sous-tâche »', async ($, on) => {
  const s = await l410($, on)
  await s.hud('lots')
  const crossed = await s.gestures(async ui => {
    await ui.pointer(down(2)) // L11/1 (à faire, affichée sous L11/2 en cours)
    await ui.pointer(up(1)) // L11/2 (en cours)
  }, 'desktop', L410_ROWS)
  expect(crossed).toMatch(/✖ L11\/2 est en cours : une sous-tâche libre se range parmi les libres/)
  const crossedDown = await s.gestures(async ui => {
    await ui.pointer(down(1)) // L11/2 (en cours)
    await ui.pointer(up(3)) // L11/3 (à faire)
  }, 'desktop', L410_ROWS)
  expect(crossedDown).toMatch(/✖ L11\/3 est libre : une sous-tâche en cours se range parmi les sous-tâches en cours/)
  expect(s.rafs()).toEqual([])
  const visible = await s.gestures(async ui => {
    await ui.pointer(down(3)) // L11/3 (à faire)
    await ui.pointer(up(2)) // L11/1 (à faire) : même groupe, l'écran suivra
  }, 'desktop', L410_ROWS)
  expect(visible).toMatch(/✔ L11\/3 placé avant L11\/1 — le plan est modifié, à commiter/)
  expect(s.rafs()).toEqual([['raf', 'move', 'L11/3', '--before', 'L11/1']])
})

// ── L402 : le tableau lu est périmé entre un raf move réussi et la fin de la relecture commencée après lui ──────────

// Le plan : L10 (libre), L11 (en cours), L12 (libre) ; à l'écran (L410) : L11 (y 0), L10 (1), L12 (2).
const STALE_TOUR = JSON.stringify([row('cadence', [lot('L10'), lot('L11', 'doing'), lot('L12')])])
/** Un tour que le test relâche à la main, appel par appel : `release()` répond au plus ancien en attente (vrai s'il y en avait un). */
const gatedTour = () => {
  const waiting: ((c: Cadence) => void)[] = []
  const tour = () => new Promise<Cadence>(resolve => waiting.push(resolve))
  const release = (stdout = STALE_TOUR) => {
    const r = waiting.shift()
    r?.({ exitCode: 0, stdout })
    return r !== undefined
  }
  return { tour, release, waiting }
}
const STALE_ROWS = 3
const DONE_L10_BEFORE_L12 = '✔ L10 placé avant L12 — le plan est modifié, à commiter (raf move ne commite pas)'
const ALREADY_L10_BEFORE_L12 = '• L10 est déjà avant L12 dans le plan : rien à déplacer'
/** « L10 avant L12 » : l'ancien tableau (L10, L11, L12) le dit déjà vrai parmi les libres ; aucun geste n'y mène (l'écran suit le plan dans un groupe), la demande est forgée. */
const forgeL10BeforeL12 = (ui: Parameters<Parameters<Awaited<ReturnType<typeof session>>['gestures']>[0]>[0]) => ui.post({ kind: 'move', project: 'cadence', id: 'L10', target: 'L12', place: 'before' }, { in: 'lots:cadence' } as never)

test('R22 — deux gestes avant la relecture : après un raf move réussi, pas de « déjà » sur l’ancien tableau, raf tranche ; la relecture finie, le court-circuit reprend', async ($, on) => {
  const s = await session($, on, { kv: SUBS_OPEN, tour: () => ({ exitCode: 0, stdout: STALE_TOUR }) })
  await s.hud('lots')
  const g = gatedTour()
  s.tour.current = g.tour // les relectures qui suivent attendent le test
  const before = s.tours().length
  await s.gestures(async ui => {
    await ui.pointer(down(1)) // L10
    await ui.pointer(up(1))
    await ui.key(altKey('down')) // voisin du dessous à l'écran : L12 → raf move L10 --after L12 (plan L11, L12, L10)
  }, 'desktop', STALE_ROWS)
  expect(await s.notice()).toBe('✔ L10 placé après L12 — le plan est modifié, à commiter (raf move ne commite pas)')
  expect(s.tours().length).toBe(before + 1) // la relecture est partie et attend : le tableau est périmé
  await s.gestures(forgeL10BeforeL12, 'desktop', STALE_ROWS) // l'ancien tableau dirait « déjà », le plan réel (L11, L12, L10) non — raf est appelé
  expect(s.rafs()).toEqual([['raf', 'move', 'L10', '--after', 'L12'], ['raf', 'move', 'L10', '--before', 'L12']])
  expect(await s.notice()).toBe(DONE_L10_BEFORE_L12) // succès simple : pas de « déjà »
  // la relecture en vol avait lu le plan avant le second move : elle ne rattrape pas, une autre part à sa fin
  expect(g.release()).toBe(true) // (le tour simulé répond toujours le plan de départ)
  await settle()
  expect(s.tours().length).toBe(before + 2)
  await s.gestures(forgeL10BeforeL12, 'desktop', STALE_ROWS) // la relecture lancée par le 1er move est finie mais pas celle d'après le 2e : encore périmé, raf tranche
  expect(s.rafs().length).toBe(3)
  expect(await s.notice()).toBe(DONE_L10_BEFORE_L12)
  expect(g.release()).toBe(true) // la relecture lancée par le 2e move finit, mais le 3e move l'a précédée : encore une
  await settle()
  expect(s.tours().length).toBe(before + 3)
  expect(g.release()).toBe(true) // celle commencée après le dernier move finit : le tableau est à jour
  await settle()
  await s.gestures(forgeL10BeforeL12, 'desktop', STALE_ROWS) // le plan relu le dit déjà : le court-circuit reprend
  expect(s.rafs().length).toBe(3)
  expect(await s.notice()).toBe(ALREADY_L10_BEFORE_L12)
  expect(g.waiting.length).toBe(0) // aucune relecture de plus que nécessaire
})

test('R22 — un tour déjà en vol au moment du move ne rattrape pas : un autre suit à sa fin, le tableau reste périmé jusque-là', async ($, on) => {
  const s = await session($, on, { kv: SUBS_OPEN, tour: () => ({ exitCode: 0, stdout: STALE_TOUR }) })
  await s.hud('lots')
  const g = gatedTour()
  s.tour.current = g.tour
  s.stamps.current = () => JSON.stringify({ '/x/cadence/.cadence/raf.yaml': 2 }) // le plan a changé : le minuteur relit, et ce tour attend
  await s.advance(5_000)
  const before = s.tours().length
  expect(g.waiting.length).toBe(1)
  await s.gestures(async ui => {
    await ui.pointer(down(1)) // L10
    await ui.pointer(up(1))
    await ui.key(altKey('down')) // raf move L10 --after L12, réussi pendant que le tour est en vol
  }, 'desktop', STALE_ROWS)
  expect(s.rafs()).toEqual([['raf', 'move', 'L10', '--after', 'L12']])
  expect(s.tours().length).toBe(before) // pas de second tour tant que le premier vole
  expect(g.release()).toBe(true) // le tour en vol revient : il avait lu le plan avant le move
  await settle()
  expect(s.tours().length).toBe(before + 1) // un autre est parti à sa fin
  await s.gestures(forgeL10BeforeL12, 'desktop', STALE_ROWS) // toujours périmé : raf est appelé
  expect(s.rafs().length).toBe(2)
  expect(await s.notice()).toBe(DONE_L10_BEFORE_L12)
  expect(g.release()).toBe(true) // ce tour avait lu le plan avant le 2e move : encore un
  await settle()
  expect(s.tours().length).toBe(before + 2)
  expect(g.release()).toBe(true)
  await settle()
  await s.gestures(forgeL10BeforeL12, 'desktop', STALE_ROWS) // relu : « déjà » reprend
  expect(s.rafs().length).toBe(2)
  expect(await s.notice()).toBe(ALREADY_L10_BEFORE_L12)
  expect(g.waiting.length).toBe(0)
})

// ── L402 × L411 : derrière « + N lots », les lots cachés ne sont pas des lignes ; au bord des lignes affichées, rien ne part ────

// Le projet « sept » : D1 … D7, tous libres ; replié (L411) la région « lots:sept » n'a que D1 (y 0) … D5 (y 4), puis le bouton « + 2 lots » hors de la région.
const SEVEN_TOUR = () => ({ exitCode: 0, stdout: JSON.stringify([row('sept', Array.from({ length: 7 }, (_, i) => lot(`D${i + 1}`)))]) })
const inSept = (e: Record<string, unknown>) => ({ ...e, in: 'lots:sept' }) as never

test('R22 — L411 : Alt+↓ sur le 5e lot, dernière ligne avant « + 2 lots », ne vise pas le lot caché : rien ne part ; Alt+↑ vise bien le 4e, affiché', async ($, on) => {
  const s = await session($, on, { tour: SEVEN_TOUR })
  await s.hud('lots')
  const d = await s.draw()
  expect(d.buttons.map(b => b.key)).toEqual(['fold:sept', 'more:sept']) // le bouton du reste est un Button du panneau, hors de la région
  expect(d.text).toMatch(/D5\b/)
  expect(d.text).not.toMatch(/D6\b/)
  await s.gestures(async ui => {
    await ui.pointer(inSept({ type: 'down', x: 4, y: 4, button: 'left' })) // D5
    await ui.pointer(inSept({ type: 'up', x: 4, y: 4, button: 'left' }))
    await ui.key(inSept({ key: 'down', meta: true })) // son voisin du dessous, D6, est caché : pas une ligne, rien ne part
  }, 'desktop', 5, 'lots:sept')
  expect(s.rafs()).toEqual([])
  expect(await s.notice()).toBeUndefined()
  await s.gestures(async ui => {
    await ui.pointer(inSept({ type: 'down', x: 4, y: 4, button: 'left' }))
    await ui.pointer(inSept({ type: 'up', x: 4, y: 4, button: 'left' }))
    await ui.key(inSept({ key: 'up', meta: true })) // D4, affiché
  }, 'desktop', 5, 'lots:sept')
  expect(s.rafs()).toEqual([['raf', 'move', 'D5', '--before', 'D4']])
})

test('R22 — L411 : le reste déplié (« + 2 lots »), D6 est une ligne : Alt+↓ sur D5 le vise, et un glisser l’atteint', async ($, on) => {
  const s = await session($, on, { tour: SEVEN_TOUR })
  await s.hud('lots')
  await s.pressKey('more:sept')
  expect((await s.draw()).text).toMatch(/D7\b/)
  await s.gestures(async ui => {
    await ui.pointer(inSept({ type: 'down', x: 4, y: 4, button: 'left' })) // D5
    await ui.pointer(inSept({ type: 'up', x: 4, y: 4, button: 'left' }))
    await ui.key(inSept({ key: 'down', meta: true }))
  }, 'desktop', 7, 'lots:sept')
  await s.gestures(async ui => {
    await ui.pointer(inSept({ type: 'down', x: 4, y: 6, button: 'left' })) // D7
    await ui.pointer(inSept({ type: 'up', x: 4, y: 4, button: 'left' })) // sur D5
  }, 'desktop', 7, 'lots:sept')
  expect(s.rafs()).toEqual([['raf', 'move', 'D5', '--after', 'D6'], ['raf', 'move', 'D7', '--before', 'D5']])
})

test('R23 — L410 : le contrôle « même parent » porte sur la ligne visée à l’écran', async ($, on) => {
  const s = await l410($, on)
  await s.hud('lots')
  const text = await s.gestures(async ui => {
    await ui.pointer(down(4)) // L10
    await ui.pointer(up(2)) // L11/1, sous-tâche de L11 : voisine à l'écran, pas dans le plan
  }, 'desktop', L410_ROWS)
  expect(s.rafs()).toEqual([])
  expect(text).toMatch(/✖ L10 et L11\/1 n'ont pas le même parent/)
})

// ── L412 : « ce qui attend une décision », en tête du panneau ───────────────────────────────────────────────────────

const ASKING: Wave = { ...WAVE, lots: [{ ...WAVE.lots[0]!, lot: 'L80', status: 'question', questions: ['Quel format ?'] }] }

test('R12 — une question de session s’affiche en tête du panneau, avant l’arbre, avec la commande --answer', async ($, on) => {
  const s = await session($, on, { waves: [ASKING] })
  await s.advance(5_000)
  await s.hud('lots')
  const { texts } = await s.draw()
  const at = (re: RegExp) => texts.findIndex(t => re.test(t))
  expect(at(/Ce qui attend une décision \(1\)/)).toBeGreaterThan(-1)
  expect(at(/\? ol:L80 .*Quel format \?/)).toBeGreaterThan(at(/Ce qui attend/))
  expect(at(/cadence orchestrate --resume --wave w1 --answer ol:L80 "…"/)).toBeGreaterThan(-1)
  expect(at(/L401/)).toBeGreaterThan(at(/--answer/)) // l'arbre vient après le bloc
})

test('R13 — rien à décider : le bloc n’apparaît pas', async ($, on) => {
  const s = await session($, on, { waves: [WAVE] })
  await s.advance(5_000)
  await s.hud('lots')
  expect((await s.draw()).text).not.toMatch(/Ce qui attend/)
})

test('R14 — une livraison en échec se lit sur le journal des livraisons, panneau ouvert seulement', async ($, on) => {
  const failed = JSON.stringify([{ project: 'maritime', day: '2026-10-29', sha: 'abc1234', reason: 'CI en échec' }])
  const s = await session($, on, { deliveries: () => failed })
  await s.advance(5_000)
  expect(s.runs.filter(a => a[3] === DELIVERIES)).toEqual([])
  await s.hud('lots')
  await s.advance(5_000)
  expect((await s.draw()).text).toMatch(/✖ maritime +livraison : abc1234 · CI en échec \(2026-10-29\)/)
})

test('R15 — le bloc ne prend jamais plus de la moitié du corps : l’arbre garde sa place', async ($, on) => {
  const lots = Array.from({ length: 8 }, (_, i) => ({ ...WAVE.lots[0]!, lot: `Q${i}`, status: 'question', questions: ['q'] }))
  const s = await session($, on, { waves: [{ ...WAVE, lots }] })
  await s.advance(5_000)
  await s.hud('lots')
  const { text } = await s.draw(70, 12)
  expect(text).toMatch(/… \+\d+ décisions? de plus/)
  expect(text).toMatch(/▾ cadence/)
})
