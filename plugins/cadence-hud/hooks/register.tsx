import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren, Timer } from 'claude-code'

import type { AgentsSummary, CommandInfo, ModelsSummary, Project, Usage, Wave, WaveLot } from '../types'
import { CONTEXT_WRITER, COLLECTOR, LAUNCH_FOLDER, parseWaves } from './collect'
import { activeProjects, ago, attributeTurn, bar, colorOfDone, colorOfLot, colorOfPercent, commandLabel, commandsText, commonProject, endedCommands, endedOwners, fit, fitSegments, isInside, k, launchFolder, limitLabel, isWaveShown, lotCells, lotCounts, modelsText, notifiedEnd, parseAmbiguous, parseTour, progressBar, projectFigures, RESET_BACK, shortModel, splitCommands, startedCommand, stoppedTask, tourDue, tourFolder, trackCommand, untilReset, waveSignature, wavePercent, waveSessions, waveStatusFr, withoutIds } from './format'

const PLUGIN = 'cadence-hud'
const REFRESH_MS = 5_000

const usage = atom({ plugin: 'cadence-hud', key: 'usage' } as const, null)
const agents = atom({ plugin: 'cadence-hud', key: 'agents' } as const, { running: 0, names: [] })
const commands = atom({ plugin: 'cadence-hud', key: 'commands' } as const, [])
const owners = atom({ plugin: 'cadence-hud', key: 'commandOwners' } as const, {})
const info = atom({ plugin: 'cadence-hud', key: 'commandInfo' } as const, {})
const models = atom({ plugin: 'cadence-hud', key: 'models' } as const, { byModel: {}, usdSeen: 0 })
const waves = atom({ plugin: 'cadence-hud', key: 'waves' } as const, [])
const projects = atom({ plugin: 'cadence-hud', key: 'projects' } as const, [])
const projectsFolded = atom({ plugin: 'cadence-hud', key: 'projectsFolded' } as const, false)
const error = atom({ plugin: 'cadence-hud', key: 'error' } as const, null)
const isHidden = atom({ plugin: 'cadence-hud', key: 'isHidden' } as const, false)
const now = atom({ plugin: 'cadence-hud', key: 'now' } as const, 0)

/** Une tâche finie sort des commandes, avec celles que son sous-agent avait lancées ; propriétaires et fiches ne perdent
 *  QUE les identifiants retirés par cette fin : une commande en train de naître (propriétaire déjà écrit, pas encore
 *  comptée) n'est dans aucune liste et doit garder les siens. */
const endCommand = async ($: Parameters<typeof read>[0], ended: string): Promise<void> => {
  const o = await read($, owners)
  let removed: string[] = [ended]
  await update($, commands, (ids: string[]) => {
    const left = endedCommands(ids, o, ended)
    removed = [ended, ...ids.filter(i => !left.includes(i))]
    return left
  })
  await update($, owners, (cur: Record<string, string>) => withoutIds(cur, removed))
  await update($, info, (cur: Record<string, CommandInfo>) => withoutIds(cur, removed))
}

export const register: Register = on => {
  let timer: Timer | undefined
  let isRefreshing = false
  let isTouring = false
  let tourSignature: string | undefined
  let tourAt = 0
  let sessionCwd: string | undefined
  // le cwd de session.start tel quel : c'est lui que `cadence session context` retrouve (le dossier de lancement ne sert qu'à l'avancement)
  let startCwd: string | undefined

  on('session.start', async ($, e, next) => {
    // Le dossier du tableau est celui de lancement, pas le dossier courant du shell : un cd du lead dans un sous-projet
    // (ou un rechargement à chaud qui revient avec ce dossier) ne le déplace pas (L154, vu 10-09 : une seule ligne).
    startCwd = e.cwd
    if (!sessionCwd || !isInside(e.cwd, sessionCwd)) {
      const r = await $.process.run(['python3', '-I', '-c', LAUNCH_FOLDER, e.cwd], { timeoutMs: 4_000 }).catch(() => undefined)
      sessionCwd = r && r.exitCode === 0 ? launchFolder(r.stdout, e.cwd) : e.cwd
    }
    tourSignature = undefined
    // Une session démarre sans commande d'arrière-plan ; un rechargement à chaud du mod aussi (il refait session.start) :
    // le compte repart de zéro plutôt que de garder des identifiants dont la fin ne reviendra jamais (vu 08-10 : « 3 cmd »).
    await update($, commands, () => [])
    await update($, owners, () => ({}))
    await update($, info, () => ({}))
    await $.command.register({
      name: 'hud',
      description: 'Affiche ou masque la bande cadence-hud ; « /hud cmd » liste les commandes d\'arrière-plan comptées, « /hud projets » replie la liste des projets',
    })

    const refresh = async () => {
      if (isRefreshing) return
      isRefreshing = true
      try {
        const [u, collected, at] = await Promise.all([
          $.session.usage().catch(() => null),
          $.process.run(['python3', '-I', '-c', COLLECTOR], { timeoutMs: 4_000 }).catch(err => ({
            exitCode: -1,
            stdout: '',
            stderr: String(err),
          })),
          $.clock.now(),
        ])
        // Les propriétaires puis la liste des agents sont lus APRÈS l'attente du collecteur (jusqu'à 4 s), dans cet ordre :
        // un propriétaire inscrit s'est lancé avant la lecture de la liste et y figure s'il tourne encore ; un sous-agent
        // lancé pendant l'attente n'est pas encore inscrit, donc jamais pris pour un disparu (liste lue avant l'attente :
        // sa première commande était retirée puis ajoutée sans fiche, « 1 cmd » pour toujours).
        const ownersNow = await read($, owners)
        let listed = true
        const list = await $.agent.list().catch(() => {
          listed = false
          return []
        })

        const nextUsage: Usage | null = u
          ? {
              percent: u.context.percent,
              tokens: u.context.tokens,
              window: u.context.window,
              usd: u.cost?.usd,
              limits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
            }
          : null
        // un sous-agent fini (ou disparu) emporte ses commandes même si son avis de fin n'a pas été vu
        if (listed) for (const gone of endedOwners(ownersNow, list)) await endCommand($, gone)
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

        // le contexte sort de la bande : la session lead le lit avec `cadence session context` (un fichier par session, rattaché à son dossier ;
        // accessoire : un échec ne coûte qu'une lecture)
        if (nextUsage && nextUsage.percent !== undefined) {
          const session = await $.session.id().catch(() => undefined)
          const cwd = startCwd ?? (await $.session.cwd().catch(() => undefined))
          if (session && cwd) {
            const published = JSON.stringify({ session, cwd, percent: nextUsage.percent, tokens: nextUsage.tokens, window: nextUsage.window, at })
            await $.process.run(['python3', '-I', '-c', CONTEXT_WRITER, published], { timeoutMs: 4_000 }).catch(() => undefined)
          }
        }
        await update($, usage, () => nextUsage)
        await update($, agents, () => summary)
        await update($, waves, () => found)
        await update($, error, () => problem)
        await update($, now, () => at)
        void refreshProjects(found, at)
      } finally {
        isRefreshing = false
      }
    }

    // L'avancement des plans vient de `cadence lead tour --json` : relu à chaque transition de vague, sinon toutes les minutes.
    // Hors de refresh() (un `cadence` lent ne retarde pas la bande) et sans effet sur `error` : cadence absent = pas de lignes de projets.
    const refreshProjects = async (found: Wave[], at: number) => {
      const signature = waveSignature(found)
      const folder = tourFolder(found, sessionCwd)
      if (isTouring || !folder || !tourDue(tourSignature, tourAt, signature, at)) return
      isTouring = true
      tourSignature = signature
      tourAt = at
      try {
        const r = await $.process.run(['cadence', 'lead', 'tour', folder, '--json'], { timeoutMs: 20_000 })
        if (r.exitCode === 0) await update($, projects, () => activeProjects(parseTour(r.stdout)))
      } catch {
        // cadence absent, sortie illisible, délai dépassé : on garde le dernier tableau lu
      } finally {
        isTouring = false
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
    if (started) {
      // le propriétaire d'abord, la commande en dernier : une fin tombant entre les écritures ne trouve pas encore la commande
      // dans `commands` et ne la retire pas, mais elle laisse propriétaire et fiche (endCommand ne retire que ses propres ids) :
      // si c'était la fin de son sous-agent, le filet de refresh (endedOwners) la retire au tour suivant
      const agent = e.agentId
      if (agent) await update($, owners, (o: Record<string, string>) => ({ ...o, [started]: agent }))
      // sans horloge, la commande est comptée quand même (sans fiche : la bande l'écrit « sans fin vue », faute d'âge)
      const since = await $.clock.now().catch(() => undefined)
      if (since !== undefined) {
        await update($, info, (cur: Record<string, CommandInfo>) => ({ ...cur, [started]: { tool: e.tool, label: commandLabel(e.tool, e), since } }))
      }
      await update($, commands, (ids: string[]) => trackCommand(ids, started, true))
    } else {
      const stopped = stoppedTask(e.tool, result.result, e)
      if (stopped) await endCommand($, stopped)
    }
    return result
  }).catch(
    // la tenue de registre est accessoire : une écriture d'état qui échoue perd une ligne du HUD, le résultat de l'outil passe
    ($, e, next) => next(e),
  )

  on('prompt.submit', async ($, e, next) => {
    const ended = notifiedEnd(e.origin, e.text)
    if (ended) await endCommand($, ended)
    return next(e)
  }).catch(
    // idem : le prompt part même si la tenue de registre échoue
    ($, e, next) => next(e),
  )

  on('command.run', { command: 'hud' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'cmd') {
      const [ids, i, o, at] = await Promise.all([read($, commands), read($, info), read($, owners), $.clock.now()])
      return { text: commandsText(ids, i, o, at) }
    }
    if (arg === 'projets') {
      const folded = !(await read($, projectsFolded))
      await update($, projectsFolded, () => folded)
      return { text: folded ? 'liste des projets repliée (/hud projets pour la rouvrir).' : 'liste des projets affichée.' }
    }
    // un argument inconnu ne bascule pas la bande : se tromper d'argument ne doit pas la faire disparaître sans un mot
    if (arg !== '') return { text: `argument inconnu : ${fit(arg, 40)} (attendu : cmd, projets)` }
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)

    return { text: hidden ? 'cadence-hud masquée (/hud pour la réafficher).' : 'cadence-hud affichée.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const [u, a, cmds, cmdInfo, m, allWaves, problem, at, allProjects, folded] = await Promise.all([
      read($, usage),
      read($, agents),
      read($, commands),
      read($, info),
      read($, models),
      read($, waves),
      read($, error),
      read($, now),
      read($, projects),
      read($, projectsFolded),
    ])
    const w = allWaves.filter(wave => isWaveShown(wave, at))
    const shownProjects = activeProjects(allProjects)
    if (u === null && w.length === 0 && problem === null && shownProjects.length === 0) return next(e)

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
      const { live: liveCmds, stale: staleCmds } = splitCommands(cmds, cmdInfo, at)
      if (liveCmds.length > 0) {
        const label = `${liveCmds.length} cmd`
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
      if (staleCmds.length > 0) {
        const label = `${staleCmds.length} cmd sans fin vue`
        segments.push({
          key: 'stale-commands',
          text: `${SEP}${label}`,
          drop: 3,
          node: (
            <Text key="stale-commands">
              {sep}
              <Text dimColor>{label}</Text>
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
      const titleWidth = Math.max(0, width - 2 - lotWidth - 2 - statusWidth - (detailWidth > 0 ? detailWidth + 2 : 0) - 2)

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
              <Box width={2 + lotWidth} paddingLeft={2} flexShrink={0}>
                <Text wrap="truncate-end" bold color={c.lot.status === 'question' || c.lot.status === 'failed' ? colorOfLot(c.lot.status) : 'text'}>
                  {c.label}
                </Text>
              </Box>
              <Box width={2 + statusWidth} paddingLeft={2} flexShrink={0}>
                <Text wrap="truncate-end" color={colorOfLot(c.lot.status)} bold={c.lot.status === 'question'}>
                  {c.status}
                </Text>
              </Box>
              {detailWidth > 0 && (
                <Box width={2 + detailWidth} paddingLeft={2} flexShrink={0}>
                  <Text wrap="truncate-end" dimColor={c.lot.status !== 'question'} color={c.lot.status === 'question' ? 'warning' : undefined}>
                    {c.detail}
                  </Text>
                </Box>
              )}
              <Box flexGrow={1} flexShrink={1} width={titleWidth + 2} paddingLeft={2}>
                <Text wrap="truncate-end" color="subtle">
                  {c.lot.title}
                </Text>
              </Box>
            </Box>
          ))}
          {queued.length > 0 && (
            <Box flexDirection="row">
              <Box width={2 + lotWidth} flexShrink={0} />
              <Box width={2 + statusWidth} paddingLeft={2} flexShrink={0}>
                <Text wrap="truncate-end" color="subtle">
                  en attente
                </Text>
              </Box>
              {detailWidth > 0 && <Box width={2 + detailWidth} flexShrink={0} />}
              <Box flexGrow={1} flexShrink={1} width={titleWidth + 2} paddingLeft={2}>
                <Text wrap="wrap" color="subtle">
                  {queued.map(label).join(' · ')}
                </Text>
              </Box>
            </Box>
          )}
        </Box>
      )
    })

    const nameWidth = Math.max(0, ...shownProjects.map(p => p.project.length))
    const projectRows =
      shownProjects.length === 0 ? null : folded ? (
        <Text key="projects" color="subtle" wrap="truncate-end">
          ▸ projets ({shownProjects.length}) : /hud projets pour les afficher
        </Text>
      ) : (
        <Box key="projects" flexDirection="column">
          {shownProjects.map(p => (
            <Box key={`project-${p.project}`} flexDirection="row">
              <Box width={nameWidth} flexShrink={0}>
                <Text wrap="truncate-end" color="subtle">
                  {p.project}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} paddingLeft={1}>
                {(() => {
                  const { done, doing, todo } = p.progress
                  const barText = progressBar(done, done + doing + todo)
                  const filled = barText.replace(/▯/g, '')
                  return (
                    <Box flexDirection="row">
                      {filled && <Text color={colorOfDone(done, done + doing + todo)}>{filled}</Text>}
                      <Text color="subtle">{barText.slice(filled.length)}</Text>
                      <Box paddingLeft={1} flexShrink={1}>
                        <Text wrap="truncate-end" color="subtle">
                          {projectFigures(p)}
                        </Text>
                      </Box>
                    </Box>
                  )
                })()}
              </Box>
            </Box>
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column">
        {contextRow}
        {waveRows}
        {projectRows}
        {problem && (
          <Text color="warning" dimColor>
            cadence-hud : {fit(problem, width - 14)}
          </Text>
        )}
      </Box>
    )
  })
}
