export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type ToolTally = { name: string; count: number; errors: number }

export type RunStatus = 'running' | 'answer' | 'aborted' | 'refusal' | 'error'

export type Run = {
  id: string
  seq: number
  prompt: string
  startedAt: number
  endedAt: number | null
  status: RunStatus
  model: string | null
  requests: number
  subRequests: number
  tokens: Tokens
  subTokens: Tokens
  tools: ToolTally[]
  costAtStart: number | null
  costUsd: number | null
  contextPercent: number | null
  // Absent on runs recorded before these were tracked.
  /** Prompt tokens of each main-loop request, in order */
  stepInputs?: number[]
  /** Context window tokens when the run ended */
  contextTokens?: number | null
  /** contextTokens minus the previous run's */
  contextDelta?: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'run-status': {
      current: Run | null
      history: Run[]
      seq: number
      /** turn_duration row uuid → the id of the run it closes */
      rows: Record<string, string>
    }
  }
}
