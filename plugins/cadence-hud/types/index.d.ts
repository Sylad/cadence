export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  percent?: number
  tokens?: number
  window: number
  usd?: number
  limits: RateLimit[]
}

/** Ce que `/hud cmd` sait d'une commande d'arrière-plan comptée : l'outil, son nom court et l'heure (ms) où le mod l'a vue naître. */
export type CommandInfo = { tool: string; label: string; since: number }

// dans `declare module 'claude-code'`, « CommandInfo » nommerait le type des commandes slash du module : un alias hors du bloc lève l'ambiguïté
export type BackgroundCommandInfo = CommandInfo

export type AgentsSummary = { running: number; names: string[] }

/** Ce qu'un modèle a consommé sur la session : tokens (entrée + sortie + cache) et dollars qui lui sont attribués. */
export type ModelSpend = { tokens: number; usd: number }

/** La consommation par modèle, par nom court (`fable`, `sonnet`…), et le dernier total de coût déjà réparti. */
export type ModelsSummary = { byModel: Record<string, ModelSpend>; usdSeen: number }

export type WaveStep = {
  kind: string
  model: string
  started: string
  pid?: number
  alive: boolean
  sub: number
}

export type WaveLot = {
  project: string
  lot: string
  title: string
  status: string
  pass: number
  model: string
  next: string | null
  steps: number
  step: WaveStep | null
}

export type Wave = {
  id: string
  pid: number
  cwd: string
  cap?: number
  started: string
  status?: string
  budget?: number
  consumed?: number
  /** Vraie pour une vague dont le processus orchestrate vit ; fausse pour la dernière vague terminée, gardée en gris. */
  live: boolean
  /** Fin de la vague (date de son wave.json), seulement quand `live` est fausse. */
  ended?: string
  lots: WaveLot[]
}

declare module 'claude-code' {
  interface PluginState {
    'cadence-hud': {
      usage: Usage | null
      agents: AgentsSummary
      /** Identifiants des commandes d'arrière-plan (Bash, Monitor) en cours, sous-agents compris. */
      commands: string[]
      /** Commande → identifiant du sous-agent qui l'a lancée ; une commande de la session principale n'y figure pas. */
      commandOwners: Record<string, string>
      /** Commande → outil, nom et heure de lancement (pour `/hud cmd` et l'âge au-delà duquel elle n'est plus comptée en cours). */
      commandInfo: Record<string, BackgroundCommandInfo>
      models: ModelsSummary
      waves: Wave[]
      error: string | null
      isHidden: boolean
      now: number
    }
  }
}
