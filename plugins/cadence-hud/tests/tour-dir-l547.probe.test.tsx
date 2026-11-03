import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { COLLECTOR, LAUNCH_FOLDER } from '../hooks/collect'

declare function setTimeout(fn: () => void, ms?: number): unknown

const settle = () => new Promise<void>(resolve => setTimeout(() => resolve(), 50))
const WAVE = { id: 'w', pid: 1, cwd: '/x', cap: 2, started: '2026-10-07T19:03:10.939Z', status: 'running', live: false, lots: [] }
const TOUR = [{ project: 'ol', doing: [], drift: [], notes: [], next: null, repo: [], progress: { done: 3, doing: 0, todo: 3, added7: 0 } }]

type Resolver = (cwd: string) => { exitCode: number; stdout: string } | 'throw'

const run = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], waveCwd: string | undefined, shell: string, resolver: Resolver) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  on('state.get', () => ({ value: { value: undefined, version: 0 } }) as never)
  on('state.set', () => ({ value: { isSet: true, version: 1 } }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('process.run', async (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    runs.push(argv)
    if (argv[0] === 'cadence') return { value: { exitCode: 0, stdout: JSON.stringify(TOUR), stderr: '' } } as never
    if (argv[3] === COLLECTOR) {
      const waves = waveCwd === undefined ? [] : [{ ...WAVE, cwd: waveCwd }]
      return { value: { exitCode: 0, stdout: JSON.stringify({ waves, ended: [], holds: [], cap: 2 }), stderr: '' } } as never
    }
    if (argv.includes(LAUNCH_FOLDER)) {
      const r = resolver(argv[argv.length - 1]!)
      if (r === 'throw') throw new Error('boom')
      return { value: { ...r, stderr: '' } } as never
    }
    return { value: { exitCode: 0, stdout: '[]', stderr: '' } } as never
  })
  await $.session.start({ cwd: shell, surface: 'terminal', isInteractive: true } as never)
  await settle()
  await clock.advance(5_000)
  await settle()
  const tours = [...new Set(runs.filter(a => a[0] === 'cadence' && a[2] === 'tour').map(a => a[3]))]
  const resolverCallsFor = (cwd: string) => runs.filter(a => a.includes(LAUNCH_FOLDER) && a[a.length - 1] === cwd).length
  return { tours, resolverCallsFor, clock }
}

const ok = (stdout: string): Resolver => () => ({ exitCode: 0, stdout })

test('L547 probe — le résolveur lève une exception : le tour retombe sur le cwd de la vague, sans planter', async ($, on) => {
  const r = await run($, on, '/solo/p', '/w/ol', c => (c === '/solo/p' ? 'throw' : { exitCode: 0, stdout: '/w/ol\n' }))
  expect(r.tours).toEqual(['/solo/p'])
})

test('L547 probe — le résolveur répond un dossier étranger à l’arborescence : le cwd de la vague, jamais ce dossier', async ($, on) => {
  const r = await run($, on, '/w/ol', '/ailleurs', ok('/etc\n'))
  expect(r.tours).toEqual(['/w/ol'])
})

test('L547 probe — le résolveur répond du bruit (JSON, vide) : le cwd de la vague', async ($, on) => {
  expect((await run($, on, '/w/ol', '/s', ok(''))).tours).toEqual(['/w/ol'])
})

test('L547 probe — le résolveur répond la racine « / » : accepté comme ancêtre', async ($, on) => {
  expect((await run($, on, '/w/ol', '/s', ok('/\n'))).tours).toEqual(['/'])
})

test('L547 probe — cwd de vague avec barre finale : le tour se lance dans le dossier à priority:', async ($, on) => {
  const r = await run($, on, '/w/ol/', '/s', c => ({ exitCode: 0, stdout: c.startsWith('/w/') ? '/w\n' : c }))
  expect(r.tours).toEqual(['/w'])
})

test('L547 probe — un résolveur sorti en code non nul : le cwd de la vague même si stdout nomme un ancêtre', async ($, on) => {
  const r = await run($, on, '/w/ol', '/s', () => ({ exitCode: 2, stdout: '/w\n' }))
  expect(r.tours).toEqual(['/w/ol'])
})

test('L547 probe — le résolveur n’est lancé qu’une fois par cwd de vague malgré plusieurs minuteurs', async ($, on) => {
  const r = await run($, on, '/w/ol', '/s', c => ({ exitCode: 0, stdout: c.startsWith('/w/') ? '/w\n' : c }))
  await r.clock.advance(70_000)
  await settle()
  expect(r.resolverCallsFor('/w/ol')).toBe(1)
})

test('L547 probe — sans vague du tout : le dossier de la session (dossier de lancement), pas de résolveur sur un cwd de vague', async ($, on) => {
  const r = await run($, on, undefined, '/w/ol', c => ({ exitCode: 0, stdout: c.startsWith('/w/') ? '/w\n' : c }))
  expect(r.tours).toEqual(['/w'])
})

test('L547 probe — cwd de vague vide : on retombe sur le dossier de la session (pas de tour muet)', async ($, on) => {
  const r = await run($, on, '', '/w/ol', c => ({ exitCode: 0, stdout: c.startsWith('/w/') ? '/w\n' : c }))
  expect(r.tours).toEqual(['/w'])
})
