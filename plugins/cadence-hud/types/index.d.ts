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
  /** Chemin absolu du dépôt du lot (`repo` de son état, écrit par orchestrate) : la commande `raf ux` à copier commence par `cd` là (L412). */
  repo?: string | null
  lot: string
  title: string
  status: string
  pass: number
  model: string
  next: string | null
  steps: number
  step: WaveStep | null
  /** Porte du programme en cours (build ou tests), sans session claude ; absente hors d'une vague vivante. */
  gate?: { label: string; started: string } | null
  /** Questions posées par la session (L412), vides hors de l'état `question`. */
  questions?: string[]
  /** Issue du lot (état `handed-back` ou `failed` : la cause du rendu), `null` ou absente sinon (L412). */
  outcome?: string | null
  /** Verdict de la revue UX de la session (L412), posé au plan par `raf ux`. */
  uxVerdict?: string | null
  /** Le lot est visible : son verdict UX se pose au plan (L412). */
  visible?: boolean
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
  /** Nombre de dépôts que la vague tient encore (registre des vagues) : ils prennent chacun un créneau, dans la limite de son plafond. */
  repos?: number
  /** Fin de la vague (date de son wave.json), seulement quand `live` est fausse. */
  ended?: string
  lots: WaveLot[]
}

/** Une session lancée à la main par le lead et inscrite par `cadence lead hold` (`holds/<étiquette>.json` du dossier de cadence) : elle prend un créneau jusqu'à son échéance. */
export type LeadHold = { label: string; since: string; expires: string }

/** Une ligne de `cadence lead tour --json` (L149) : ce que la bande en garde pour dessiner l'avancement d'un plan. */
export type Project = {
  project: string
  /** ids des lots en cours (absent d'un cadence trop ancien) */
  doing?: { id: string }[]
  progress: { done: number; doing: number; todo: number; added7: number }
}

/** Un lot non clos de `cadence lead tour --json` (L401) ou, dans un plan natif, une sous-tâche non close (`<lot>/<n>`, `parent` = le lot, jamais d'`after`). */
export type TourLot = { id: string; title: string; status: 'todo' | 'doing'; after: string[]; parent?: string }

/** Une ligne du tour pour le panneau des lots : le projet, l'erreur du tour s'il n'a pas pu être lu, ses lots non clos. */
export type LotsRow = { project: string; error?: string; lots?: TourLot[] }

/** Ce que le panneau a lu : les lignes du tour, et si cadence est trop ancien pour porter `lots`. */
export type LotsBoard = { rows: LotsRow[]; outdated: boolean }

/** Une livraison en échec d'un projet (L412) : la dernière ligne de `deliveries-failed.log`, quand aucune livraison verte ne l'a suivie. */
export type FailedDelivery = { project: string; day: string; sha: string; reason: string }

/** Ce que le dessin demande : placer `id` juste avant ou après `target` (L402). */
export type MoveAsk = { id: string; target: string; place: 'before' | 'after' }

/** Le dernier mot du panneau sur un déplacement : fait (`done`, le plan est à commiter), sans effet (`unchanged`, le lot était déjà à cette place dans le plan) ou refusé avec sa raison (`refused`). */
export type LotsNotice = { text: string; kind: 'done' | 'unchanged' | 'refused' }

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
      /** Les vagues finies du dossier, la plus récente d'abord (vagues finies des 7 derniers jours), qu'une vague vive ou non (L412) : lues par « ce qui attend une décision » du panneau des lots, jamais par la bande (qui ne voit, dans `waves`, que la dernière et sans vague vivante). */
      endedWaves: Wave[]
      /** Projets actifs (au moins un lot ouvert), dans l'ordre de priorité de `cadence lead tour`. */
      projects: Project[]
      /** Sessions du lead inscrites par `cadence lead hold` (celles dont l'échéance est passée sont écartées au dessin). */
      leadHolds: LeadHold[]
      /** Plafond de sessions simultanées (CADENCE_MAX_SESSIONS, 2 par défaut). */
      slotCap: number
      /** La liste des projets est repliée sur une ligne (`/hud projets`). */
      projectsFolded: boolean
      /** Ce que le panneau des lots (`/hud lots`) a lu de `cadence lead tour --json` ; null avant la première lecture réussie. */
      lotsBoard: LotsBoard | null
      /** La dernière lecture du panneau des lots a échoué (cadence absent, délai dépassé, sortie illisible). */
      lotsFailed: boolean
      /** Le repli choisi par projet dans le panneau des lots (vrai = replié) ; un projet absent suit le défaut (replié au-delà de 20 lots ouverts). */
      lotsFolds: Record<string, boolean>
      /** Les dépliages choisis dans le panneau des lots (vrai = déplié) : `more:<projet>` (le reste du projet au-delà de 5 lots), `open:<projet>#<lot>` (les sous-lots d'un lot) ; absent, replié. */
      lotsViews: Record<string, boolean>
      /** Le résultat du dernier déplacement demandé dans le panneau ; null avant le premier. */
      lotsNotice: LotsNotice | null
      /** Les livraisons en échec lues pour le panneau des lots (L412), une par projet au plus. */
      lotsDeliveries: FailedDelivery[]
      /** Heure (ms) de la dernière lecture réussie du panneau des lots. */
      lotsAt: number
      error: string | null
      isHidden: boolean
      now: number
    }
  }
}
