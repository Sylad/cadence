export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  percent?: number
  tokens?: number
  window: number
  usd?: number
  limits: RateLimit[]
}

export type AgentsSummary = { running: number; names: string[] }

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
  lots: WaveLot[]
}

declare module 'claude-code' {
  interface PluginState {
    'cadence-hud': {
      usage: Usage | null
      agents: AgentsSummary
      waves: Wave[]
      error: string | null
      isHidden: boolean
      now: number
    }
  }
}
