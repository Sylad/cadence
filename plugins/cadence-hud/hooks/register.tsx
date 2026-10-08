import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren, Timer } from 'claude-code'

import type { AgentsSummary, ModelsSummary, Usage, Wave, WaveLot } from '../types'
import { COLLECTOR, parseWaves } from './collect'
import { ago, attributeTurn, bar, colorOfLot, colorOfPercent, commonProject, fit, fitSegments, k, limitLabel, lotCells, lotCounts, modelsText, notifiedEnd, pad, parseAmbiguous, RESET_BACK, shortModel, startedCommand, stoppedTask, trackCommand, untilReset, wavePercent, waveSessions, waveStatusFr } from './format'

const PLUGIN = 'cadence-hud'
const REFRESH_MS = 5_000

const usage = atom({ plugin: 'cadence-hud', key: 'usage' } as const, null)
const agents = atom({ plugin: 'cadence-hud', key: 'agents' } as const, { running: 0, names: [] })
const commands = atom({ plugin: 'cadence-hud', key: 'commands' } as const, [])
const models = atom({ plugin: 'cadence-hud', key: 'models' } as const, { byModel: {}, usdSeen: 0 })
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

  // Chaque fin de tour (boucle principale et sous-agents) attribue ses tokens au modèle qui a répondu, et la
  // part du coût de session apparue depuis la dernière fin de tour. Deux tours qui finissent ensemble se
  // partagent le coût au mieux ; la somme des parts reste égale au total de /cost.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const used = e.usage
    if (!used) return result
    const total = await $.session
      .usage()
      .then(u => u.cost?.usd)
      .catch(() => undefined)
    const name = shortModel(used.model)
    const tokens = used.input_tokens + used.output_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens
    await update($, models, (m: ModelsSummary) => attributeTurn(m, name, tokens, total))
    return result
  })

  // Les commandes d'arrière-plan sont celles que l'app range dans « commandes en arrière-plan » : Bash lancé en
  // arrière-plan et Monitor, ceux des sous-agents aussi (leurs appels passent par ici avec leur `agentId`). Elles
  // naissent au résultat de l'appel, finissent par la notification de la tâche ou par TaskStop.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!('result' in result) || result.isError) return result
    const started = startedCommand(e.tool, result.result)
    if (started) await update($, commands, (ids: string[]) => trackCommand(ids, started, true))
    else {
      const stopped = stoppedTask(e.tool, result.result)
      if (stopped) await update($, commands, (ids: string[]) => trackCommand(ids, stopped, false))
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const ended = notifiedEnd(e.origin, e.text)
    if (ended) await update($, commands, (ids: string[]) => trackCommand(ids, ended, false))
    return next(e)
  })

  on('command.run', { command: 'hud' }, async $ => {
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)

    return { text: hidden ? 'cadence-hud masquée (/hud pour la réafficher).' : 'cadence-hud affichée.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const [u, a, cmds, m, w, problem, at] = await Promise.all([
      read($, usage),
      read($, agents),
      read($, commands),
      read($, models),
      read($, waves),
      read($, error),
      read($, now),
    ])
    if (u === null && w.length === 0 && problem === null) return next(e)

    const ambiguous = parseAmbiguous(await $.env.get('CADENCE_HUD_AMBIGUOUS'))
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const sep = <Text dimColor>{'  │  '}</Text>
    const pct = (p: number | undefined) => (p === undefined ? '  -' : `${String(p).padStart(3)} %`)

    const SEP = '  │  '
    // La première ligne est UN seul Text (une Box en ligne replierait chaque segment séparément quand la fenêtre
    // est étroite) : ses segments optionnels tombent par priorité jusqu'à tenir dans la largeur, du moins utile
    // (noms des agents, puis heures de remise à zéro, puis modèles, coût, agents) au plus utile (fenêtres de quota) ; le contexte reste toujours.
    const segments: { key: string; text: string; drop: number; back?: number; requires?: string; node: RenderChildren }[] = []
    if (u) {
      const ctx = `${bar(u.percent)} ${pct(u.percent)}`
      segments.push({
        key: 'ctx',
        text: `ctx ${ctx} ${k(u.tokens)}/${k(u.window)}`,
        drop: 0,
        node: (
          <Text key="ctx">
            <Text dimColor>ctx </Text>
            <Text color={colorOfPercent(u.percent, 50, 75)} bold>
              {ctx}
            </Text>
            <Text dimColor>
              {' '}
              {k(u.tokens)}/{k(u.window)}
            </Text>
          </Text>
        ),
      })
      for (const l of u.limits) {
        segments.push({
          key: l.kind,
          text: `${SEP}${limitLabel(l.kind)} ${pct(l.percentUsed)}`,
          drop: 1,
          node: (
            <Text key={l.kind}>
              {sep}
              <Text dimColor>{limitLabel(l.kind)} </Text>
              <Text color={colorOfPercent(l.percentUsed)} bold>
                {pct(l.percentUsed)}
              </Text>
            </Text>
          ),
        })
        const reset = untilReset(l.resetsAt, at)
        if (reset) {
          segments.push({ key: `${l.kind}-reset`, text: ` ${reset}`, drop: 5, back: RESET_BACK, requires: l.kind, node: <Text key={`${l.kind}-reset`} dimColor> {reset}</Text> })
        }
      }
      if (u.usd !== undefined) {
        const usd = `$${u.usd.toFixed(2)}`
        segments.push({
          key: 'usd',
          text: `${SEP}${usd}`,
          drop: 3,
          node: (
            <Text key="usd">
              {sep}
              <Text dimColor>{usd}</Text>
            </Text>
          ),
        })
      }
      if (Object.keys(m.byModel).length > 0) {
        const text = fit(modelsText(m), 40)
        segments.push({
          key: 'models',
          text: `${SEP}${text}`,
          drop: 4,
          node: (
            <Text key="models">
              {sep}
              <Text dimColor>{text}</Text>
            </Text>
          ),
        })
      }
      if (a.running > 0) {
        const label = `⚙ ${a.running} agent${a.running > 1 ? 's' : ''}`
        segments.push({
          key: 'agents',
          text: `${SEP}${label}`,
          drop: 2,
          node: (
            <Text key="agents">
              {sep}
              <Text color="claude" bold>
                {label}
              </Text>
            </Text>
          ),
        })
        const names = fit(a.names.join(', '), 40)
        if (names) segments.push({ key: 'agent-names', text: ` ${names}`, drop: 6, requires: 'agents', node: <Text key="agent-names" dimColor> {names}</Text> })
      }
      if (cmds.length > 0) {
        const label = `${cmds.length} cmd`
        segments.push({
          key: 'commands',
          text: `${SEP}${label}`,
          drop: 2,
          node: (
            <Text key="commands">
              {sep}
              <Text color="claude" bold>
                {label}
              </Text>
            </Text>
          ),
        })
      }
    }
    const contextRow = u && (
      <Text key="usage" wrap="truncate-end">
        {fitSegments(segments, width, ambiguous).map(s => s.node)}
      </Text>
    )

    const waveRows = w.map(wave => {
      const percent = wavePercent(wave)
      if (!wave.live) {
        const project = commonProject(wave)
        return (
          <Text key={`wave-${wave.id}`} color="subtle" wrap="truncate-end">
            ⟳ {project ? `${project} · ` : ''}
            {wave.id} {waveStatusFr(wave.status)} {ago(wave.ended, at)}
            {sep}
            budget {pct(percent)} {k(wave.consumed)}/{k(wave.budget)}
            {wave.lots.length > 0 && (
              <Text color="subtle">
                {sep}
                {lotCounts(wave)}
              </Text>
            )}
          </Text>
        )
      }
      const sessions = waveSessions(wave)
      const project = commonProject(wave)
      const label = (lot: WaveLot) => (project ? lot.lot : `${lot.project}:${lot.lot}`)
      const active = wave.lots.filter(l => l.status !== 'queued')
      const queued = wave.lots.filter(l => l.status === 'queued')
      const cells = active.map(lot => {
        const c = lotCells(lot, at)
        return { lot, label: label(lot), status: c.status, detail: c.detail }
      })
      const lotWidth = Math.max(0, ...cells.map(c => c.label.length))
      const statusWidth = Math.max(0, ...cells.map(c => c.status.length), queued.length > 0 ? 'en attente'.length : 0)
      const detailWidth = Math.max(0, ...cells.map(c => c.detail.length))
      const titleWidth = width - 2 - lotWidth - 2 - statusWidth - 2 - (detailWidth > 0 ? detailWidth + 2 : 0)

      return (
        <Box key={`wave-${wave.id}`} flexDirection="column">
          <Text wrap="truncate-end">
            <Text color="claude" bold>
              ⟳ {project ? `${project} · ` : ''}
              {wave.id} {waveStatusFr(wave.status)}
            </Text>
            {sep}
            <Text dimColor>budget </Text>
            <Text color={colorOfPercent(percent)} bold>
              {bar(percent)} {pct(percent)}
            </Text>
            <Text dimColor>
              {' '}
              {k(wave.consumed)}/{k(wave.budget)}
            </Text>
            {sep}
            <Text dimColor>
              {sessions} session{sessions > 1 ? 's' : ''}
              {wave.cap ? `/${wave.cap}` : ''}
            </Text>
          </Text>
          {cells.map(c => (
            <Box key={`${c.lot.project}:${c.lot.lot}`} flexDirection="row">
              <Text>{'  '}</Text>
              <Text bold color={c.lot.status === 'question' || c.lot.status === 'failed' ? colorOfLot(c.lot.status) : 'text'}>
                {pad(c.label, lotWidth)}
              </Text>
              <Text>{'  '}</Text>
              <Text color={colorOfLot(c.lot.status)} bold={c.lot.status === 'question'}>
                {pad(c.status, statusWidth)}
              </Text>
              <Text>{'  '}</Text>
              {detailWidth > 0 && (
                <Text dimColor={c.lot.status !== 'question'} color={c.lot.status === 'question' ? 'warning' : undefined}>
                  {pad(c.detail, detailWidth)}
                </Text>
              )}
              {detailWidth > 0 && <Text>{'  '}</Text>}
              <Text color="subtle">{fit(c.lot.title, titleWidth)}</Text>
            </Box>
          ))}
          {queued.length > 0 && (
            <Box flexDirection="row">
              <Text>{'  '}</Text>
              <Text dimColor>{pad('', lotWidth)}</Text>
              <Text>{'  '}</Text>
              <Text color="subtle">{pad('en attente', statusWidth)}</Text>
              <Text>{'  '}</Text>
              <Text color="subtle" wrap="wrap">
                {queued.map(label).join(' · ')}
              </Text>
            </Box>
          )}
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
