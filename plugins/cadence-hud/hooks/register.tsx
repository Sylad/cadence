import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { AgentsSummary, Usage, Wave } from '../types'
import { COLLECTOR, parseWaves } from './collect'
import {
  bar,
  colorOfLot,
  colorOfPercent,
  fit,
  k,
  limitLabel,
  lotText,
  untilReset,
  wavePercent,
  waveSessions,
  waveStatusFr,
} from './format'

const PLUGIN = 'cadence-hud'
const REFRESH_MS = 5_000

const usage = atom({ plugin: 'cadence-hud', key: 'usage' } as const, null)
const agents = atom({ plugin: 'cadence-hud', key: 'agents' } as const, { running: 0, names: [] })
const waves = atom({ plugin: 'cadence-hud', key: 'waves' } as const, [])
const error = atom({ plugin: 'cadence-hud', key: 'error' } as const, null)
const isHidden = atom({ plugin: 'cadence-hud', key: 'isHidden' } as const, false)
const now = atom({ plugin: 'cadence-hud', key: 'now' } as const, 0)

export const register: Register = on => {
  let timer: Timer | undefined
  let isRefreshing = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hud',
      description: 'Affiche ou masque la bande cadence-hud (contexte, fenêtres, agents, vagues orchestrate)',
    })

    const refresh = async () => {
      if (isRefreshing) return
      isRefreshing = true
      try {
        const [u, list, collected, at] = await Promise.all([
          $.session.usage().catch(() => null),
          $.agent.list().catch(() => []),
          $.process.run(['python3', '-I', '-c', COLLECTOR], { timeoutMs: 4_000 }).catch(err => ({
            exitCode: -1,
            stdout: '',
            stderr: String(err),
          })),
          $.clock.now(),
        ])

        const nextUsage: Usage | null = u
          ? {
              percent: u.context.percent,
              tokens: u.context.tokens,
              window: u.context.window,
              usd: u.cost?.usd,
              limits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
            }
          : null
        const live = list.filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
        const summary: AgentsSummary = {
          running: live.length,
          names: live.map(a => a.name ?? a.type).slice(0, 4),
        }

        let found: Wave[] = []
        let problem: string | null = null
        if (collected.exitCode === 0) {
          try {
            found = parseWaves(collected.stdout)
          } catch (err) {
            problem = `collecteur illisible : ${String(err).slice(0, 60)}`
          }
        } else {
          problem = `collecteur : ${(collected.stderr || `code ${collected.exitCode}`).trim().split('\n').pop()?.slice(0, 80)}`
        }

        await update($, usage, () => nextUsage)
        await update($, agents, () => summary)
        await update($, waves, () => found)
        await update($, error, () => problem)
        await update($, now, () => at)
      } finally {
        isRefreshing = false
      }
    }

    timer?.cancel()
    timer = $.clock.every(REFRESH_MS, () => void refresh())
    void refresh()

    return next(e)
  })

  on('command.run', { command: 'hud' }, async $ => {
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)

    return { text: hidden ? 'cadence-hud masquée (/hud pour la réafficher).' : 'cadence-hud affichée.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const [u, a, w, problem, at] = await Promise.all([
      read($, usage),
      read($, agents),
      read($, waves),
      read($, error),
      read($, now),
    ])
    if (u === null && w.length === 0 && problem === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const sep = <Text dimColor> · </Text>

    const contextRow = u && (
      <Box key="usage" flexDirection="row">
        <Text dimColor>ctx </Text>
        <Text color={colorOfPercent(u.percent, 50, 75)} bold>
          {bar(u.percent)} {u.percent === undefined ? '—' : `${u.percent} %`}
        </Text>
        <Text dimColor> {k(u.tokens)}/{k(u.window)}</Text>
        {u.limits.map(l => (
          <Text key={l.kind}>
            {sep}
            <Text dimColor>{limitLabel(l.kind)} </Text>
            <Text color={colorOfPercent(l.percentUsed)} bold>
              {l.percentUsed} %
            </Text>
            {untilReset(l.resetsAt, at) ? <Text dimColor> {untilReset(l.resetsAt, at)}</Text> : null}
          </Text>
        ))}
        {u.usd !== undefined && (
          <Text>
            {sep}
            <Text dimColor>${u.usd.toFixed(2)}</Text>
          </Text>
        )}
        {a.running > 0 && (
          <Text>
            {sep}
            <Text color="claude" bold>
              ⚙ {a.running} agent{a.running > 1 ? 's' : ''}
            </Text>
            <Text dimColor> {fit(a.names.join(', '), 40)}</Text>
          </Text>
        )}
      </Box>
    )

    const waveRows = w.map(wave => {
      const percent = wavePercent(wave)
      const sessions = waveSessions(wave)
      const queued = wave.lots.filter(l => l.status === 'queued').length
      const head = `⟳ ${wave.id} ${waveStatusFr(wave.status)}`

      return (
        <Box key={`wave-${wave.id}`} flexDirection="column">
          <Box flexDirection="row">
            <Text color="claude" bold>
              {head}
            </Text>
            {sep}
            <Text dimColor>budget </Text>
            <Text color={colorOfPercent(percent)} bold>
              {k(wave.consumed)}/{k(wave.budget)}
              {percent === undefined ? '' : ` ${percent} %`}
            </Text>
            {sep}
            <Text dimColor>
              {sessions} session{sessions > 1 ? 's' : ''}
              {wave.cap ? `/${wave.cap}` : ''}
              {queued > 0 ? `, ${queued} en attente` : ''}
            </Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap">
            <Text dimColor>{'  '}</Text>
            {wave.lots.map((lot, i) => (
              <Text key={`${lot.project}:${lot.lot}`}>
                {i > 0 ? sep : null}
                <Text dimColor>{lot.project}:</Text>
                <Text color={colorOfLot(lot.status)} bold={lot.status === 'question'}>
                  {fit(lotText(lot, at), width - 4)}
                </Text>
              </Text>
            ))}
          </Box>
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        {contextRow}
        {waveRows}
        {problem && (
          <Text color="warning" dimColor>
            cadence-hud : {fit(problem, width - 14)}
          </Text>
        )}
      </Box>
    )
  })
}
