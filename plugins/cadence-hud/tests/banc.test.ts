import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { bancDetail, bancLine, duree, enCoursLine, parseBanc, readBanc, readEnCours } from '../hooks/banc'
import { BANC_READER } from '../hooks/collect'

declare function setTimeout(fn: () => void, ms?: number): unknown
const settle = () => new Promise<void>(resolve => setTimeout(() => resolve(), 50))

// 2026-11-09 est un lundi ; le samedi de la semaine du banc est le 07-11 (heure de Paris)
const LUNDI = Date.parse('2026-11-09T10:00:00+01:00')
const SAMEDI = Date.parse('2026-11-07T10:00:00+01:00')
const ligne = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ date: '2026-11-08T09:00:00.000Z', empreinte: 'e1', candidat: 'eq-legere', bancs: ['1-ol-companion-L239', '3-cadence-L12', '6-maritime-L9'], hebdo: false, frais: 0, vert: true, rouges: [], ...extra })
const hebdo = ligne({ date: '2026-11-07T08:00:00.000Z', hebdo: true, bancs: ['1-a', '2-b', '3-c', '4-d', '5-e', '6-f'] })

test('banc — dernier passage vert : vert, date JJ-MM à Paris, « court » pour les bancs 1, 3, 6, candidat/A', () => {
  expect(bancLine(parseBanc([hebdo, ligne()]), LUNDI)).toEqual({ text: 'banc ✓ 08-11 court · eq-legere/A', color: 'success' })
})

test('banc — dernier passage rouge : ses trois premiers critères rouges', () => {
  const rouge = ligne({ vert: false, rouges: ['temps total', 'relecture aveugle', 'tests cachés', 'cohérence UI'] })
  expect(bancLine(parseBanc([hebdo, rouge]), LUNDI)).toEqual({ text: 'banc ✗ 08-11 : temps total, relecture aveugle, tests cachés', color: 'error' })
})

test('banc — en semaine sans passage hebdo depuis samedi : orange « weekend manquant »', () => {
  expect(bancLine(parseBanc([ligne()]), LUNDI)).toEqual({ text: 'banc ⚠ weekend manquant', color: 'warning' })
})

test('banc — rouge ET weekend manquant : la ligne rouge, suivie du rappel', () => {
  const rouge = ligne({ vert: false, rouges: ['temps total'] })
  expect(bancLine(parseBanc([rouge]), LUNDI)).toEqual({ text: 'banc ✗ 08-11 : temps total · ⚠ weekend manquant', color: 'error' })
})

test('banc — le samedi et le dimanche, rien ne manque encore', () => {
  const vieux = ligne({ date: '2026-11-03T09:00:00.000Z', bancs: ['1-a'] })
  expect(bancLine(parseBanc([vieux]), SAMEDI)).toEqual({ text: 'banc ✓ 03-11 éclair · eq-legere/A', color: 'success' })
})

test('banc — un passage hebdo de vendredi soir ne couvre pas le weekend (samedi 00:00 heure de Paris)', () => {
  const vendredi = ligne({ date: '2026-11-06T22:30:00.000Z', hebdo: true }) // vendredi 23:30 Paris
  expect(bancLine(parseBanc([vendredi]), LUNDI)?.text).toBe('banc ⚠ weekend manquant')
  const samediMinuit = ligne({ date: '2026-11-06T23:30:00.000Z', hebdo: true }) // samedi 00:30 Paris
  expect(bancLine(parseBanc([samediMinuit]), LUNDI)?.color).toBe('success')
})

test('banc — sorte du passage : hebdo, éclair, N bancs', () => {
  const sorte = (extra: Record<string, unknown>) => bancLine(parseBanc([hebdo, ligne(extra)]), LUNDI)?.text
  expect(sorte({ hebdo: true, bancs: ['1-a', '2-b'] })).toBe('banc ✓ 08-11 hebdo · eq-legere/A')
  expect(sorte({ bancs: ['1-a'] })).toBe('banc ✓ 08-11 éclair · eq-legere/A')
  expect(sorte({ bancs: ['1-a', '2-b'] })).toBe('banc ✓ 08-11 2 bancs · eq-legere/A')
  expect(sorte({ bancs: ['1-a', '3-b', '6-c', '7-d'] })).toBe('banc ✓ 08-11 4 bancs · eq-legere/A')
})

test('banc — une ligne type sequence : sorte « séquence », dans la bande et le détail', () => {
  const seq = ligne({ type: 'sequence', bancs: ['1-aether-b68'] })
  expect(bancLine(parseBanc([hebdo, seq]), LUNDI)?.text).toBe('banc ✓ 08-11 séquence · eq-legere/A')
  expect(bancDetail(parseBanc([seq]))[0]).toMatch(/ séquence {2}✓ vert$/)
  expect(bancLine(parseBanc([hebdo, ligne({ type: 'autre', bancs: ['1-a'] })]), LUNDI)?.text).toBe('banc ✓ 08-11 éclair · eq-legere/A')
})

test('banc — répétitions (ids <banc>#k) : la sorte compte les bancs de base', () => {
  const sorte = (bancs: string[]) => bancLine(parseBanc([hebdo, ligne({ bancs })]), LUNDI)?.text
  expect(sorte(['1-a#1', '1-a#2', '3-b#1', '3-b#2', '6-c#1', '6-c#2'])).toBe('banc ✓ 08-11 court · eq-legere/A')
  expect(sorte(['1-a#1', '1-a#2'])).toBe('banc ✓ 08-11 éclair · eq-legere/A')
  expect(sorte(['1-a#1', '1-a#2', '2-b#1', '2-b#2'])).toBe('banc ✓ 08-11 2 bancs · eq-legere/A')
})

test('banc — contrôles éclair rouges (eclair_ok: false) : ✗ même si le verdict est vert', () => {
  const eclair = ligne({ bancs: ['1-a'], eclair_ok: false })
  expect(bancLine(parseBanc([hebdo, eclair]), LUNDI)).toEqual({ text: 'banc ✗ 08-11 : contrôles éclair', color: 'error' })
  expect(bancDetail(parseBanc([eclair]))).toEqual(['08-11 10:00  éclair  ✗ rouge : contrôles éclair'])
  expect(bancLine(parseBanc([hebdo, ligne({ bancs: ['1-a'], eclair_ok: true })]), LUNDI)?.color).toBe('success')
})

test('banc — lignes illisibles sautées, historique absent ou vide sans passage : aucune ligne', () => {
  expect(parseBanc(['', 'pas du json', '{"date":"x"}', '[1]', 'null', ligne()]).length).toBe(1)
  expect(bancLine(null, LUNDI)).toBeNull()
  expect(bancLine([], SAMEDI)).toBeNull()
})

test('banc — le panneau : les 5 derniers passages, le plus récent d\'abord', () => {
  const passages = parseBanc([
    hebdo,
    ...[3, 4, 5, 6].map(j => ligne({ date: `2026-11-0${j}T09:00:00.000Z` })),
    ligne({ vert: false, rouges: ['temps total', 'cohérence UI'] }),
  ])
  expect(bancDetail(passages)).toEqual([
    '08-11 10:00  court  ✗ rouge : temps total, cohérence UI',
    '06-11 10:00  court  ✓ vert',
    '05-11 10:00  court  ✓ vert',
    '04-11 10:00  court  ✓ vert',
    '03-11 10:00  court  ✓ vert',
  ])
})

test('banc — la sortie du lecteur : null quand le fichier manque, ses lignes sinon ; une sortie illisible lève', () => {
  expect(readBanc('{"h":null,"c":null}')).toBeNull()
  expect(readBanc(JSON.stringify({ h: [ligne(), 'cassée', 42], c: null }))?.length).toBe(1)
  expect(() => readBanc('{"x":1}')).toThrow()
  expect(() => readBanc('pas du json')).toThrow()
})

/** Monte le mod : état en mémoire, horloge au lundi, le lecteur du banc répond `historique` (null = fichier absent), toute autre commande échoue. */
const monte = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], historique: string[] | null, c: string | null = null) => {
  const store = new Map<string, { value: unknown; version: number }>()
  on('state.get', (_$, e) => ({ value: store.get(e.key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_$, e) => {
    const version = (store.get(e.key)?.version ?? 0) + 1
    store.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } } as never
  })
  const clock = mock.clock(on, { now: LUNDI })
  mock.env(on, {})
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    if (argv[3] === BANC_READER) return { value: { exitCode: 0, stdout: JSON.stringify({ h: historique, c }), stderr: '' } } as never
    return { value: { exitCode: 1, stdout: '', stderr: 'absent' } } as never
  })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true } as never)
  await settle()
  await clock.advance(5_000)
  await settle()
  return store
}
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const

test('banc — branché : la bande dessine la ligne du banc lue par le lecteur, le panneau des lots ses 5 derniers passages', async ($, on) => {
  await monte($, on, [hebdo, ligne({ vert: false, rouges: ['temps total'] })])
  const band = await $.ui.mount({ plugin: 'cadence-hud', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /^banc ✗ 08-11 : temps total$/ })).toBeDefined()
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'cadence-hud', surface: 'terminal', component: 'Pane', requestId: 'lots', props: { title: 'Lots', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never)
  expect(await pane.find({ type: 'Text', text: /^Banc : 2 derniers passages$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /court {2}✗ rouge : temps total$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /hebdo {2}✓ vert$/ })).toBeDefined()
  await pane.unmount()
})

test('banc — branché, historique absent : ni ligne dans la bande, ni bloc dans le panneau', async ($, on) => {
  const store = await monte($, on, null)
  expect(store.get('banc')?.value).toBeNull()
  const band = await $.ui.mount({ plugin: 'cadence-hud', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /banc/ })).toBeUndefined()
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'cadence-hud', surface: 'terminal', component: 'Pane', requestId: 'lots', props: { title: 'Lots', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never)
  expect(await pane.find({ type: 'Text', text: /Banc/ })).toBeUndefined()
  await pane.unmount()
})

const T0 = Date.parse('2026-11-09T10:00:00+01:00')
const encours = (extra: Record<string, unknown> = {}) => ({ run: 'r', debut: new Date(T0 - 84 * 60_000).toISOString(), candidat: 'equipe-legere', reference: 'A', bancs_total: 6, banc: '3-ol-companion-L241', repetition: 1,
  phase: 'bras equipe-legere', phase_debut: new Date(T0 - 7 * 60_000).toISOString(), termines: 2, ...extra })

test('banc en cours — la ligne : position, banc, phase avec sa durée, durée totale ; accent', () => {
  expect(enCoursLine(encours(), T0)).toEqual({ text: 'banc ⟳ 3/6 bancs · 3-ol-companion-L241 #1 · bras equipe-legere · 7 min (depuis 1 h 24)', color: 'claude' })
  expect(enCoursLine(null, T0)).toBeNull()
  expect([duree(0), duree(59 * 60_000), duree(3600_000), duree(-5)]).toEqual(['0 min', '59 min', '1 h 00', '0 min'])
})

test('banc en cours — plus de 6 h sans changement de phase : orange, « bloqué ? »', () => {
  const l = enCoursLine(encours({ phase_debut: new Date(T0 - 6.5 * 3600_000).toISOString() }), T0)
  expect(l?.color).toBe('warning')
  expect(l?.text).toMatch(/ · bloqué \?$/)
  expect(enCoursLine(encours({ phase_debut: new Date(T0 - 5 * 3600_000).toISOString() }), T0)?.color).toBe('claude')
})

test('banc en cours — la lecture : illisible ou incomplet = null', () => {
  expect(readEnCours(JSON.stringify({ h: null, c: JSON.stringify(encours()) }))?.banc).toBe('3-ol-companion-L241')
  expect(readEnCours(JSON.stringify({ h: null, c: null }))).toBeNull()
  expect(readEnCours(JSON.stringify({ h: null, c: '{coupé' }))).toBeNull()
  expect(readEnCours(JSON.stringify({ h: null, c: '{"banc":"x"}' }))).toBeNull()
})

test('banc en cours — branché : la ligne ⟳ passe avant la ligne du banc dans la bande, et en tête du panneau', async ($, on) => {
  await monte($, on, [hebdo, ligne()], JSON.stringify(encours({ debut: new Date(LUNDI - 84 * 60_000).toISOString(), phase_debut: new Date(LUNDI - 7 * 60_000).toISOString() })))
  const band = await $.ui.mount({ plugin: 'cadence-hud', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /^banc ⟳ 3\/6 bancs · 3-ol-companion-L241 #1 · bras equipe-legere · \d+ min \(depuis 1 h \d+\)$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^banc ✓ 08-11/ })).toBeDefined()
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'cadence-hud', surface: 'terminal', component: 'Pane', requestId: 'lots', props: { title: 'Lots', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never)
  expect(await pane.find({ type: 'Text', text: /^banc ⟳ 3\/6/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Banc : 2 derniers passages$/ })).toBeDefined()
  await pane.unmount()
})
