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

/** Un passage du banc de cadence 2, une ligne de `historique.jsonl` (ligneHistorique de v2/src/bench/verdict.ts) ; `sequence` : ligne `type: 'sequence'` (v2/src/sequence/verdict.ts). */
export type BancPassage = { date: string; candidat: string; bancs: string[]; hebdo: boolean; vert: boolean; rouges: string[]; sequence?: boolean; niveau?: string }

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
  /** Les pas du lot (genre, statut, début, fin), dans l'ordre : la frise du cycle du panneau des lots (L413) en tire ses étapes. Absent d'un collecteur plus ancien. */
  trail?: { kind: string; status: string; started: string; ended?: string }[]
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
  /** Plafond des tokens du lot, part réservée à l'escalade comprise (`budget` de son état, L414) ; absent d'un état sans budget. */
  budget?: number | null
  /** Part de `budget` réservée à l'escalade de modèle ; absente sans escalade déclarée. */
  escalationReserve?: number | null
  /** L'escalade de modèle est engagée : la part réservée est libérée. */
  escalated?: boolean
  /** Estimate du plan, en jours : la taille du lot, clé du temps habituel de `cadence perf`. */
  estimate?: number | null
  /** Le lot est passé par une étape de la chaîne spec (classe « +spec » de `cadence perf`). */
  spec?: boolean
  /** Tokens comptés par les étapes du lot, comme le journal de `cadence perf`. */
  consumed?: number
  /** Début de la première étape (ISO), nul sans étape. */
  since?: string | null
}

export type Wave = {
  id: string
  pid: number
  cwd: string
  cap?: number | null
  started: string
  status?: string
  budget?: number
  consumed?: number
  /** Vraie pour une vague dont le processus orchestrate vit ; fausse pour la dernière vague terminée, gardée en gris. */
  live: boolean
  /** Nombre de dépôts que la vague tient encore (registre des vagues) : ils prennent chacun un créneau, dans la limite de son plafond. */
  repos?: number
  /** Lots de la vague qui tiennent une session claude en mode worktree (registre des vagues, L589 ; hors lots réglés, en attente ou en porte) : un créneau chacun, dépôt tenu ou non ; absent hors worktree ou d'un cadence plus ancien. */
  lanes?: number
  /** Fin de la vague (date de son wave.json), seulement quand `live` est fausse. */
  ended?: string
  lots: WaveLot[]
}

/** Une session lancée à la main par le lead et inscrite par `cadence lead hold` (`holds/<étiquette>.json` du dossier de cadence) : elle prend un créneau jusqu'à son échéance. */
export type LeadHold = { label: string; since: string; expires: string }

/** Un run de `cadence run` vivant (L710) : il prend un créneau de sessions comme une session du lead. */
export type LiveRun = { id: string; repo: string }

/**
 * Un run de `cadence run` à montrer (L687, D-1), lu de son fichier d'état (`.cadence-run/<dépôt>-<id>.json`) et de son verrou : `etat` est celui de
 * `cadence run --liste` (`en-cours` sans porteur vivant devient `interrompu`), `role` celui du porteur vivant (`session` : il joue ; `attente` : il attend le quota), null sans porteur.
 */
export type ShownRun = {
  id: string
  repo: string
  lot: string | null
  etat: string
  role: string | null
  debut?: string | null
  modele?: string | null
  cout?: number | null
  /** La première ligne de la demande. */
  titre: string
  /** L'heure de reprise d'un run en quota. */
  reprise?: string | null
  /** La dernière écriture de l'état (ISO). */
  vu: string
}

/** Une ligne de `cadence lead tour --json` (L149) : ce que la bande en garde pour dessiner l'avancement d'un plan. */
export type Project = {
  project: string
  /** ids des lots en cours (absent d'un cadence trop ancien) */
  doing?: { id: string }[]
  progress: { done: number; doing: number; todo: number; added7: number }
}

/** Un lot non clos de `cadence lead tour --json` (L401) ou, dans un plan natif, une sous-tâche non close (`<lot>/<n>`, `parent` = le lot, jamais d'`after`). */
export type TourLot = { id: string; title: string; status: 'todo' | 'doing'; after: string[]; parent?: string; /** La revue de code du lot est posée au plan (L413) ; absent sans revue ou d'un cadence plus ancien. */ reviewed?: true }

/** Une ligne du tour pour le panneau des lots : le projet, l'erreur du tour s'il n'a pas pu être lu, ses lots non clos. */
export type LotsRow = { project: string; error?: string; lots?: TourLot[]; /** Lots clos et leur jour de clôture (L415) ; absent d'un cadence plus ancien ou sans lot clos daté. */ closed?: { id: string; finished: string; /** Le plan dit le lot livré hors de cadence deliver (L530) ; absent sinon. */ delivered?: true }[]; /** L'avancement du projet, tel que la bande l'écrit (L481) ; absent d'un cadence plus ancien. */ progress?: Project['progress']; /** Ids des lots en cours (L481), pour les chiffres de l'avancement. */ doing?: { id: string }[] }

/** Ce que le panneau a lu : les lignes du tour, et si cadence est trop ancien pour porter `lots`. */
export type LotsBoard = { rows: LotsRow[]; outdated: boolean }

/** Une livraison en échec d'un projet (L412) : la dernière ligne de `deliveries-failed.log`, quand aucune livraison verte ne l'a suivie. */
export type FailedDelivery = { project: string; day: string; sha: string; reason: string }

/** La dernière livraison d'un projet (L415), lue par le script LAST_DELIVERIES : son jour et son sha, verte ou rouge, et le jour de la dernière livraison verte (nul sans). */
export type LastDelivery = { project: string; day: string; sha: string; status: 'verte' | 'rouge'; green: string | null }

/** Ce que le dessin demande : placer `id` juste avant ou après `target` (L402). */
export type MoveAsk = { id: string; target: string; place: 'before' | 'after' }

/** Le dernier mot du panneau sur un déplacement : fait (`done`, le plan est à commiter), sans effet (`unchanged`, le lot était déjà à cette place dans le plan) ou refusé avec sa raison (`refused`). */
export type LotsNotice = { text: string; kind: 'done' | 'unchanged' | 'refused' }

/** `en-cours.json` du banc : le passage qui tourne (écrit à chaque changement de phase par `passage`). */
export type EnCours = { run: string; debut: string; candidat: string; reference: string; bancs_total: number; banc: string; repetition: number; phase: string; phase_debut: string; termines: number; /** Banc séquence seulement : « k/n » (étape 0 = préparation) et nombre de répétitions. */ etape?: string; repetitions?: number }

declare module 'claude-code' {
  interface PluginState {
    'cadence-hud': {
      /** Les passages du banc lus de `historique.jsonl` (Task 16, cadence 2) ; null quand le fichier n'existe pas. */
      banc: BancPassage[] | null
      /** Le passage du banc en cours (`en-cours.json`) ; null quand aucun ne tourne. */
      enCours: EnCours | null
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
      /** Sessions du lead inscrites par `cadence lead hold` (celles dont l'échéance est passée sont écartées au dessin). */
      leadHolds: LeadHold[]
      /** Runs de `cadence run` vivants (L710) : ils comptent dans les créneaux. */
      liveRuns: LiveRun[]
      /** Les runs de `cadence run` à montrer avec leur état (L687) : vivants, intégrés depuis moins de 30 min, en attente d'un geste depuis moins de 12 h. */
      shownRuns: ShownRun[]
      /** Le panneau des lots est ouvert (L687) : la bande ne répète pas l'historique du banc qu'il montre. */
      lotsOpen: boolean
      /** Plafond de sessions simultanées (CADENCE_MAX_SESSIONS, 2 par défaut). */
      slotCap: number
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
      /** La dernière livraison de chaque projet lue pour le panneau des lots (L415). */
      lotsLast: LastDelivery[]
      /** Le temps habituel d'un lot (minutes) par classe de taille, lu de `cadence perf --json` (L414) ; vide tant qu'il n'a pas répondu. */
      lotsTypical: Record<string, number>
      /** Heure (ms) de la dernière lecture réussie du panneau des lots. */
      lotsAt: number
      error: string | null
      isHidden: boolean
      now: number
    }
  }
}
