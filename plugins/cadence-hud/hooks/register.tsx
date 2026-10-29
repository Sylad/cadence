import { atom, read, update } from 'claude-code'
import type { ClientProps, ElementConstructor, EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { AgentsSummary, CommandInfo, LeadHold, LotsNotice, ModelsSummary, Project, Usage, Wave, WaveLot } from '../types'
import { CONTEXT_WRITER, COLLECTOR, DEFAULT_CAP, DELIVERIES, LAUNCH_FOLDER, PLAN_STAMPS, parseCollected } from './collect'
import { buildDecisions, decisionsOf, parseDeliveries } from './decisions'
import { activeProjects, ago, attributeTurn, bar, colorOfDone, colorOfLot, colorOfPercent, commandLabel, commandsText, commonProject, endedCommands, endedOwners, fit, expiredHolds, expiredHoldText, fitSegments, holdText, isInside, k, launchFolder, limitLabel, isWaveShown, liveHolds, lotCells, lotCounts, modelsText, notifiedEnd, parseAmbiguous, parseTour, progressBar, projectFigures, RESET_BACK, shortModel, slotsLine, splitCommands, startedCommand, stoppedTask, tourDue, tourFolder, trackCommand, untilReset, waveSignature, wavePercent, waveSessions, waveStatusFr, withoutIds } from './format'

import { lotRow } from './lot-row'
import { buildPanel, ellipsize, isFolded, moreKey, moreText, parseLotsBoard, parseMoveAsk, parseToggleAsk, planMove, projectDir, rankerOf, readTime, refusalReason, stampsSignature, waveLotsOf } from './lots'
import type { PanelLot } from './lots'

const PLUGIN = 'cadence-hud'
/** Id du panneau des lots (`/hud lots`). */
const LOTS_PANE = 'lots'
/** Clé du `$.store` (gardé entre deux sessions) où le panneau des lots garde le repli choisi de chaque projet. */
const FOLDS_KEY = 'lotsFolds'
/** Clé du `$.store` où le panneau des lots garde les dépliages choisis (le reste d'un projet, les sous-lots d'un lot). */
const VIEWS_KEY = 'lotsViews'
const REFRESH_MS = 5_000
/** Le dernier mot du panneau sur un déplacement, sous le titre : fait (vert), sans effet (le lot était déjà là, en couleur du texte), refusé (rouge). */
const NOTICE_LOOK: Record<LotsNotice['kind'], { glyph: string; color: 'success' | 'text' | 'error' }> = { done: { glyph: '✔ ', color: 'success' }, unchanged: { glyph: '• ', color: 'text' }, refused: { glyph: '✖ ', color: 'error' } }

const usage = atom({ plugin: 'cadence-hud', key: 'usage' } as const, null)
const agents = atom({ plugin: 'cadence-hud', key: 'agents' } as const, { running: 0, names: [] })
const commands = atom({ plugin: 'cadence-hud', key: 'commands' } as const, [])
const owners = atom({ plugin: 'cadence-hud', key: 'commandOwners' } as const, {})
const info = atom({ plugin: 'cadence-hud', key: 'commandInfo' } as const, {})
const models = atom({ plugin: 'cadence-hud', key: 'models' } as const, { byModel: {}, usdSeen: 0 })
const waves = atom({ plugin: 'cadence-hud', key: 'waves' } as const, [])
const projects = atom({ plugin: 'cadence-hud', key: 'projects' } as const, [])
const leadHolds = atom({ plugin: 'cadence-hud', key: 'leadHolds' } as const, [])
const slotCap = atom({ plugin: 'cadence-hud', key: 'slotCap' } as const, DEFAULT_CAP)
const projectsFolded = atom({ plugin: 'cadence-hud', key: 'projectsFolded' } as const, false)
const lotsBoard = atom({ plugin: 'cadence-hud', key: 'lotsBoard' } as const, null)
const lotsFailed = atom({ plugin: 'cadence-hud', key: 'lotsFailed' } as const, false)
const lotsFolds = atom({ plugin: 'cadence-hud', key: 'lotsFolds' } as const, {})
const lotsViews = atom({ plugin: 'cadence-hud', key: 'lotsViews' } as const, {})
const lotsNotice = atom({ plugin: 'cadence-hud', key: 'lotsNotice' } as const, null)
const lotsDeliveries = atom({ plugin: 'cadence-hud', key: 'lotsDeliveries' } as const, [])
const lotsAt = atom({ plugin: 'cadence-hud', key: 'lotsAt' } as const, 0)
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

/** Le panneau des lots est ouvert (ni ouvert seul, ni deviné : le moteur le dit) ; une liste illisible vaut fermé. */
const isLotsOpen = ($: EngineInterface): Promise<boolean> =>
  $.ui.panes().then(
    list => list.some(p => p.id === LOTS_PANE),
    () => false,
  )

/** Replie le projet s'il est déplié et inversement ; le choix est gardé. Renvoie le nouvel état (vrai = replié), `undefined` si le projet n'est pas dans le tableau lu. */
const toggleFold = async ($: EngineInterface, project: string): Promise<boolean | undefined> => {
  const row = (await read($, lotsBoard))?.rows.find(r => r.project === project && !r.error)
  if (!row) return undefined
  const folded = !isFolded(project, row.lots ?? [], await read($, lotsFolds))
  const next = { ...(await read($, lotsFolds)), [project]: folded }
  await update($, lotsFolds, () => next)
  await $.store.set(FOLDS_KEY, next).catch(() => undefined) // accessoire : sans magasin, le choix vaut pour la session
  return folded
}

/** Déplie ce qui est replié et inversement (clé de moreKey ou openKey) ; le choix est gardé. */
const toggleView = async ($: EngineInterface, key: string): Promise<void> => {
  const current = await read($, lotsViews)
  const next = { ...current, [key]: !current[key] }
  await update($, lotsViews, () => next)
  await $.store.set(VIEWS_KEY, next).catch(() => undefined) // accessoire : sans magasin, le choix vaut pour la session
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const onlyBooleans = (v: Record<string, unknown>): Record<string, boolean> => Object.fromEntries(Object.entries(v).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'))

/** Garde le dernier mot du panneau sur un déplacement (fait, sans effet, ou refusé avec sa raison) : il s'affiche sous le titre. */
const say = ($: EngineInterface, text: string, kind: LotsNotice['kind']): Promise<void> => update($, lotsNotice, () => ({ text, kind }) satisfies LotsNotice).then(() => undefined)

export const register: Register = on => {
  let timer: Timer | undefined
  let isRefreshing = false
  let isTouring = false
  let tourSignature: string | undefined
  let tourAt = 0
  let sessionCwd: string | undefined
  // le cwd de session.start tel quel : c'est lui que `cadence session context` retrouve (le dossier de lancement ne sert qu'à l'avancement)
  let startCwd: string | undefined
  let readTourNow: (() => Promise<void>) | undefined
  let isMoving = false
  // Le tableau lu est PÉRIMÉ depuis un `raf move` réussi jusqu'à la fin d'une relecture commencée après lui : `moveGen` compte les déplacements réussis,
  // `boardGen` celui qu'avait vu la relecture qui a écrit le tableau (une relecture déjà en vol au moment du move a lu l'ancien plan : elle ne rattrape pas).
  let moveGen = 0
  let boardGen = 0
  // Une relecture demandée pendant qu'une autre est en vol : à relancer à la fin de celle-ci
  let tourAgain = false

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
    // Le repli choisi dans le panneau des lots survit à la session ; un magasin illisible laisse les défauts.
    const kept = await $.store.get(FOLDS_KEY).catch(() => undefined)
    if (isRecord(kept)) await update($, lotsFolds, () => onlyBooleans(kept))
    const keptViews = await $.store.get(VIEWS_KEY).catch(() => undefined)
    if (isRecord(keptViews)) await update($, lotsViews, () => onlyBooleans(keptViews))
    await $.command.register({
      name: 'hud',
      description: 'Affiche ou masque la bande cadence-hud ; « /hud cmd » liste les commandes d\'arrière-plan comptées, « /hud projets » replie la liste des projets, « /hud lots » ouvre ou ferme le panneau des lots, « /hud lots <projet> » y replie ou déplie un projet',
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
        let foundHolds: LeadHold[] = []
        let foundCap = DEFAULT_CAP
        let problem: string | null = null
        if (collected.exitCode === 0) {
          try {
            ;({ waves: found, holds: foundHolds, cap: foundCap } = parseCollected(collected.stdout))
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
        await update($, leadHolds, () => foundHolds)
        await update($, slotCap, () => foundCap)
        await update($, error, () => problem)
        await update($, now, () => at)
        void refreshProjects(found, at)
        void refreshDeliveries(found)
      } finally {
        isRefreshing = false
      }
    }

    // Les livraisons en échec (L412) : lues tant que le panneau des lots est ouvert, à chaque rafraîchissement (deux `stat` par projet) ; un journal illisible n'en montre aucune.
    const refreshDeliveries = async (found: Wave[]) => {
      const folder = tourFolder(found, sessionCwd)
      if (!folder || !(await isLotsOpen($))) return
      const failed = await $.process.run(['python3', '-I', '-c', DELIVERIES, folder], { timeoutMs: 4_000 }).then(r => (r.exitCode === 0 ? parseDeliveries(r.stdout) : []), () => [])
      // le délai peut tomber après le déchargement du module : l'écriture est alors refusée et il n'y a plus rien à dire
      await update($, lotsDeliveries, () => failed).catch(() => undefined)
    }
    // L'avancement des plans vient de `cadence lead tour --json` : relu à chaque transition de vague, sinon toutes les minutes.
    // Hors de refresh() (un `cadence` lent ne retarde pas la bande) et sans effet sur `error` : cadence absent = pas de lignes de projets.
    // La même lecture nourrit le panneau des lots (L401) ; tant qu'il est ouvert, la date de modification des plans fait aussi relire.
    const refreshProjects = async (found: Wave[], at: number) => {
      const folder = tourFolder(found, sessionCwd)
      if (isTouring || !folder) return
      const stamps = (await isLotsOpen($)) ? await $.process.run(['python3', '-I', '-c', PLAN_STAMPS, folder], { timeoutMs: 4_000 }).then(r => (r.exitCode === 0 ? stampsSignature(r.stdout) : ''), () => '') : ''
      const signature = stamps ? `${waveSignature(found)}#${stamps}` : waveSignature(found)
      if (isTouring || !tourDue(tourSignature, tourAt, signature, at)) return
      isTouring = true
      tourSignature = signature
      tourAt = at
      const gen = moveGen // les déplacements réussis avant que ce tour lise le plan
      try {
        const r = await $.process.run(['cadence', 'lead', 'tour', folder, '--json'], { timeoutMs: 20_000 })
        if (r.exitCode !== 0) throw new Error(`cadence lead tour : code ${r.exitCode}`)
        const board = parseLotsBoard(r.stdout)
        const tour = parseTour(r.stdout)
        await update($, projects, () => activeProjects(tour))
        await update($, lotsBoard, () => board)
        await update($, lotsFailed, () => false)
        await update($, lotsAt, () => at)
        boardGen = gen
      } catch {
        // cadence absent, sortie illisible, délai dépassé : la bande et le panneau gardent le dernier tableau lu.
        // Le délai (20 s) peut tomber après le déchargement du module (rechargement du mod, fin de session) : l'état n'est plus à lui,
        // l'écriture est refusée et il n'y a plus rien à dire — un rejet laissé ici n'aurait aucun preneur (refreshProjects n'est pas attendu).
        await update($, lotsFailed, () => true).catch(() => undefined)
      } finally {
        isTouring = false
        if (tourAgain) {
          tourAgain = false
          void readTourNow?.()
        }
      }
    }
    // Relit tout de suite, sans attendre le minuteur : à l'ouverture du panneau, après un déplacement réussi.
    // Un tour déjà en vol a lu le plan avant la demande : un autre suit à sa fin, on ne se contente pas de lui.
    readTourNow = async () => {
      tourSignature = undefined
      if (isTouring) {
        tourAgain = true
        return
      }
      const [found, at] = await Promise.all([read($, waves), $.clock.now()])
      await refreshProjects(found, at)
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
    if (arg.startsWith('lots ')) {
      const project = arg.slice(5).trim()
      if (!(await read($, lotsBoard))) return { text: 'les plans ne sont pas encore lus : réessayez dans un instant.' }
      const folded = await toggleFold($, project)
      if (folded === undefined) {
        const names = ((await read($, lotsBoard))?.rows ?? []).filter(r => !r.error).map(r => r.project)
        return { text: `projet inconnu : ${fit(project, 40)} (projets : ${names.join(', ') || 'aucun'})` }
      }
      return { text: `${project} ${folded ? 'replié' : 'déplié'}.` }
    }
    if (arg === 'lots') {
      if (await isLotsOpen($)) {
        await $.ui.close({ id: LOTS_PANE })
        return { text: 'panneau des lots fermé.' }
      }
      // demandé par la commande, le panneau est placé à toute largeur : c'est le moteur qui décide (`presentation.columns` ne décrit pas la place d'un panneau, sur desktop notamment)
      const opened = await $.ui.open({ id: LOTS_PANE, title: 'Lots' })
      if (!opened.isPlaced) return { text: `panneau des lots non placé : ${opened.reason}` }
      void readTourNow?.()
      return { text: 'panneau des lots ouvert (/hud lots pour le fermer).' }
    }
    // un argument inconnu ne bascule pas la bande : se tromper d'argument ne doit pas la faire disparaître sans un mot
    if (arg !== '') return { text: `argument inconnu : ${fit(arg, 40)} (attendu : cmd, projets, lots)` }
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)

    return { text: hidden ? 'cadence-hud masquée (/hud pour la réafficher).' : 'cadence-hud affichée.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const [u, a, cmds, cmdInfo, m, allWaves, problem, at, allProjects, folded, allHolds, cap] = await Promise.all([
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
      read($, leadHolds),
      read($, slotCap),
    ])
    const w = allWaves.filter(wave => isWaveShown(wave, at))
    const shownProjects = activeProjects(allProjects)
    const holds = liveHolds(allHolds, at)
    const lateHolds = expiredHolds(allHolds, at)
    if (u === null && w.length === 0 && problem === null && shownProjects.length === 0 && holds.length === 0 && lateHolds.length === 0) return next(e)

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

    // comme `cadence orchestrate --status` : la ligne des créneaux, puis une ligne par session que le lead a inscrite
    const slots = slotsLine(w, holds, cap)
    const leadRows = (slots || lateHolds.length > 0) && (
      <Box key="lead" flexDirection="column">
        {slots && (
          <Text color="subtle" wrap="truncate-end">
            {slots}
          </Text>
        )}
        {holds.map(hold => (
          <Text key={`hold-${hold.label}`} dimColor wrap="truncate-end">
            {'  '}
            {holdText(hold, at)}
          </Text>
        ))}
        {lateHolds.map(hold => (
          <Text key={`late-${hold.label}`} color={colorOfLot('failed')} wrap="truncate-end">
            {expiredHoldText(hold, at)}
          </Text>
        ))}
      </Box>
    )

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
        {leadRows}
        {projectRows}
        {problem && (
          <Text color="warning" dimColor>
            cadence-hud : {fit(problem, width - 14)}
          </Text>
        )}
      </Box>
    )
  })

  // Le dépôt d'un lot (ou d'une sous-tâche) posté par la région Client du panneau (L402) : contrôlé contre le tableau lu, puis `raf move` dans le projet.
  // L'écran est trié par état (L410), pas dans l'ordre du plan : un lot ne se réordonne qu'à l'intérieur de son groupe d'affichage (en cours, libres, le reste) — un dépôt sur un lot
  // d'un autre groupe est refusé sans appeler raf (planMove), un dépôt qui laisse l'ordre du groupe tel qu'il est n'appelle pas raf et le dit (« déjà »). Ces jugements se font sur le
  // tableau lu : tant qu'il est périmé (un `raf move` a réussi, la relecture commencée après lui n'est pas finie — `cadence lead tour` prend plusieurs secondes), on ne juge pas « déjà » : raf tranche.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== LOTS_PANE) return next(e)
    const [board, allWaves, at] = await Promise.all([read($, lotsBoard), read($, waves), read($, now)])
    // la bascule des sous-lots d'un lot (L411), postée par la région parce que c'est elle qui reçoit le pointeur et le clavier de ses lignes
    const toggle = parseToggleAsk(e.data, board?.rows ?? [])
    if (toggle) {
      await toggleView($, toggle.key)
      return {}
    }
    const ask = parseMoveAsk(e.data)
    const project = board?.rows.find(r => r.project === ask?.project && !r.error)
    if (!ask || !board || !project || isMoving) return {}
    const plan = planMove(project.lots ?? [], ask, rankerOf(project, waveLotsOf(allWaves, at)), boardGen !== moveGen)
    if (!plan) return {}
    if (plan.kind === 'refused') {
      await say($, plan.reason, 'refused')
      return {}
    }
    if (plan.kind === 'unchanged') {
      await say($, plan.text, 'unchanged')
      return {}
    }
    const folder = tourFolder(allWaves, sessionCwd)
    if (!folder) {
      await say($, 'dossier des plans inconnu : rien n\'a été déplacé', 'refused')
      return {}
    }
    isMoving = true
    try {
      const r = await $.process.run(plan.argv, { cwd: projectDir(folder, ask.project, board.rows), timeoutMs: 10_000 }).catch(() => undefined)
      if (!r) await say($, `raf move n’a pas pu être lancé (raf absent du PATH ou sans réponse) : rien n’a été déplacé`, 'refused')
      else if (r.exitCode !== 0) await say($, refusalReason(r.stderr, r.exitCode), 'refused')
      else {
        const done = `${ask.id} placé ${ask.place === 'before' ? 'avant' : 'après'} ${ask.target} — le plan est modifié, à commiter (raf move ne commite pas)`
        await say($, done, 'done')
        moveGen += 1 // le tableau est périmé jusqu'à la fin d'une relecture commencée maintenant
        void readTourNow?.()
      }
    } finally {
      isMoving = false
    }
    return {}
  })

  // Le panneau des lots (L401) : lecture seule, l'arbre des lots non clos de chaque projet du dossier (lead tour --json).
  on('ui.render', { component: 'Pane', requestId: LOTS_PANE }, async ($, e) => {
    const [board, failed, readAt, allWaves, at, folds, views, notice, deliveries] = await Promise.all([read($, lotsBoard), read($, lotsFailed), read($, lotsAt), read($, waves), read($, now), read($, lotsFolds), read($, lotsViews), read($, lotsNotice), read($, lotsDeliveries)])
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // les surfaces sans région Client (mobile, éditeur) dessinent les lots sans les réordonner
    const Client: ElementConstructor<ClientProps> | undefined = e.surface === 'terminal' || e.surface === 'desktop' ? (table as { Client: ElementConstructor<ClientProps> }).Client : undefined
    const columns = Math.max(20, e.props.bodyColumns)
    const header = (
      <Text key="header" wrap="truncate-end">
        <Text bold>Lots</Text>
        <Text dimColor>
          {'  '}{Client ? 'glisser un lot, ou Alt+↑ / Alt+↓' : 'lecture seule'}{board ? `  lu à ${readTime(readAt)}` : ''}
        </Text>
      </Text>
    )
    const footer = (
      <Text key="footer" dimColor wrap="truncate-end">
        /hud lots pour fermer
      </Text>
    )
    const message = (text: string, color: 'error' | 'subtle') => (
      <Text key="message" color={color} wrap="wrap">
        {text}
      </Text>
    )

    // « ce qui attend une décision » (L412) : au plus la moitié du corps, l'arbre garde le reste
    const decisions = buildDecisions(decisionsOf(allWaves, deliveries), columns, Math.max(3, Math.floor(e.props.scroll.bodyRows / 2)))
    const decisionBlock = decisions.lines.length > 0 && (
      <Box key="decisions" flexDirection="column">
        {decisions.lines.map((l, i) => (
          <Text key={`d${i}`} bold={l.tone === 'title'} dimColor={l.tone === 'subtle'} color={l.tone === 'error' ? 'error' : undefined} wrap="truncate-end">
            {l.text}
          </Text>
        ))}
      </Box>
    )

    let body: RenderChildren
    if (board?.outdated) {
      body = message('Lots indisponibles : cadence est trop ancien, mettez-le à jour.', 'error')
    } else if (board === null) {
      body = failed ? message("Lots illisibles : cadence lead tour n'a pas répondu. Nouvelle lecture dans une minute.", 'error') : message('Lecture des plans…', 'subtle')
    } else {
      const panel = buildPanel({ rows: board.rows, columns, height: e.props.scroll.bodyRows - decisions.lines.length, waves: waveLotsOf(allWaves, at), folds, views })
      if (panel.lines.length === 0) {
        body = message('Aucun lot non clos dans les projets de ce dossier.', 'subtle')
      } else {
        // une région Client par projet : on ne réordonne qu'à l'intérieur de son projet
        const rows: RenderChildren[] = []
        let run: PanelLot[] = []
        let runProject = ''
        const flush = () => {
          if (run.length === 0) return
          rows.push(
            Client ? (
              <Client key={`lots:${runProject}`} module="./lots-list.tsx" props={{ project: runProject, lines: run }} width="100%" />
            ) : (
              <Box key={`r${rows.length}`} flexDirection="column">
                {run.map((l, j) => lotRow(table, l, `l${j}`, l.subs ? { onToggle: () => void toggleView($, l.subs!.key) } : {}))}
              </Box>
            ),
          )
          run = []
        }
        panel.lines.forEach((line, i) => {
          if (line.kind === 'lot') {
            run.push(line)
            return
          }
          flush()
          // le bouton « + N lots » / « moins » du reste d'un projet (L411) ferme la région de ses lots : les lots cachés derrière lui ne sont pas des lignes, on ne les vise pas
          if (line.kind === 'more') {
            rows.push(
              <Box key={`m${i}`} paddingLeft={2}>
                <Button key={`more:${line.project}`} plain onPress={() => void toggleView($, moreKey(line.project))}>
                  {moreText(line.hidden, line.expanded)}
                </Button>
              </Box>,
            )
            return
          }
          runProject = line.name
          rows.push(
            <Box key={`p${i}`} flexDirection="row">
              {line.folded === undefined ? (
                <Text bold wrap="truncate-end">
                  {line.name}
                </Text>
              ) : (
                <Button key={`fold:${line.name}`} plain onPress={() => void toggleFold($, line.name)}>
                  {`${line.folded ? '▸' : '▾'} ${line.name}`}
                </Button>
              )}
              {line.error ? (
                <Text color="error" wrap="truncate-end">
                  {'  '}
                  {ellipsize(line.error, columns - line.name.length - 2)}
                </Text>
              ) : (
                <Text dimColor wrap="truncate-end">
                  {'  '}
                  {line.count} lot{line.count > 1 ? 's' : ''} non clos{line.folded ? ` · ${line.doing} en cours` : ''}
                </Text>
              )}
            </Box>,
          )
        })
        flush()
        body = (
          <Box key="tree" flexDirection="column">
            {rows}
            {panel.more > 0 && (
              <Text dimColor>
                … +{panel.more} lot{panel.more > 1 ? 's' : ''} de plus
              </Text>
            )}
          </Box>
        )
      }
    }
    const result = notice && (
      <Text key="notice" color={NOTICE_LOOK[notice.kind].color} wrap="wrap">
        {NOTICE_LOOK[notice.kind].glyph}
        {notice.text}
      </Text>
    )
    return (
      <Box flexDirection="column">
        {header}
        {result}
        {decisionBlock}
        {body}
        {footer}
      </Box>
    )
  })
}
