import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, ResolveInput } from 'claude-code'

import type { Run, RunStatus, Tokens, ToolTally } from '../types'

const PANE = 'run-status'
const HISTORY_LIMIT = 50
const STORE_KEY = 'runs'
const ROWS_KEY = 'rows'
const STORE_LIMIT = 200

const current = atom({ plugin: 'run-status', key: 'current' } as const, null)
const history = atom({ plugin: 'run-status', key: 'history' } as const, [])
const seq = atom({ plugin: 'run-status', key: 'seq' } as const, 0)
const rows = atom({ plugin: 'run-status', key: 'rows' } as const, {})

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function addUsage(t: Tokens, u: Usage): Tokens {
  return {
    input: t.input + u.input_tokens,
    output: t.output + u.output_tokens,
    cacheRead: t.cacheRead + u.cache_read_input_tokens,
    cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
  }
}

function sumTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

/** Share of prompt tokens served from cache; null before any prompt token. */
export function cacheHitRate(t: Tokens): number | null {
  const prompt: number = t.input + t.cacheRead + t.cacheWrite
  return prompt === 0 ? null : t.cacheRead / prompt
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function fmtDuration(ms: number): string {
  const s: number = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m: number = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

function fmtPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

function cacheColor(rate: number | null): string | undefined {
  if (rate === null) return undefined
  if (rate >= 0.8) return 'green'
  if (rate >= 0.5) return 'yellow'
  return 'red'
}

const STATUS_LABEL: Record<RunStatus, string> = {
  running: '● running',
  answer: '✓ done',
  aborted: '■ aborted',
  refusal: '⚠ refusal',
  error: '✗ error',
}

const STATUS_COLOR: Record<RunStatus, string> = {
  running: 'cyan',
  answer: 'green',
  aborted: 'yellow',
  refusal: 'yellow',
  error: 'red',
}

function toolTotals(tools: readonly ToolTally[]): { calls: number; errors: number } {
  let calls: number = 0
  let errors: number = 0
  for (const t of tools) {
    calls += t.count
    errors += t.errors
  }
  return { calls, errors }
}

function tally(tools: readonly ToolTally[], name: string, field: 'count' | 'errors'): ToolTally[] {
  const found: boolean = tools.some(t => t.name === name)
  const base: ToolTally[] = found ? [...tools] : [...tools, { name, count: 0, errors: 0 }]
  return base.map(t => (t.name === name ? { ...t, [field]: t[field] + 1 } : t))
}

async function sessionCost($: EngineInterface): Promise<number | null> {
  return (await $.session.usage()).cost?.usd ?? null
}

/** Applies fn to the running run, if there is one. */
function patchRunning($: EngineInterface, fn: (run: Run) => Run): Promise<unknown> {
  return update($, current, run => (run !== null && run.status === 'running' ? fn(run) : run))
}

function elapsed(run: Run, now: number): number {
  return (run.endedAt ?? now) - run.startedAt
}

type Segment = { text: string; color?: string; isDim?: true }

type Weather = { icon: string; word: string; color: string }

/** Context fill as a forecast, after token-weather's scale. */
export function weatherOf(percent: number): Weather {
  if (percent < 25) return { icon: '☀', word: 'Clear', color: 'green' }
  if (percent < 50) return { icon: '☁', word: 'Cloudy', color: 'cyan' }
  if (percent < 75) return { icon: '☂', word: 'Showers', color: 'yellow' }
  if (percent < 90) return { icon: '☇', word: 'Storm', color: 'red' }
  return { icon: '↯', word: 'Compact soon', color: 'red' }
}

const BARS: string = '▁▂▃▄▅▆▇█'
const SPARK_MAX: number = 40
/** Growth under this many tokens stays near the floor, so a flat run reads flat. */
const SPARK_MIN_RANGE: number = 10_000

export function sparkline(values: readonly number[]): string {
  const shown: readonly number[] = values.slice(-SPARK_MAX)
  if (shown.length === 0) return ''
  const lo: number = Math.min(...shown)
  const range: number = Math.max(Math.max(...shown) - lo, SPARK_MIN_RANGE)
  return shown.map(v => BARS[Math.round(((v - lo) / range) * (BARS.length - 1))]).join('')
}

function fmtDelta(n: number): string {
  if (n === 0) return '±0'
  return n > 0 ? `▲+${fmtTokens(n)}` : `▼-${fmtTokens(-n)}`
}

function promptTokens(u: Usage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

/** The forecast row of a finished run: context fill, its change, and how it grew request by request. */
export function weatherSegments(run: Run): Segment[] {
  if (run.contextPercent === null) return []
  const w: Weather = weatherOf(run.contextPercent)
  const segments: Segment[] = [
    { text: `${w.icon} ${w.word}`, color: w.color },
    { text: `ctx ${run.contextPercent}%` },
  ]
  const delta: number | null = run.contextDelta ?? null
  if (delta !== null) segments.push({ text: fmtDelta(delta), color: delta > 0 ? 'yellow' : 'green' })
  const spark: string = sparkline(run.stepInputs ?? [])
  if (spark !== '') segments.push({ text: 'req', isDim: true }, { text: spark, color: w.color })
  return segments
}

/** The run's stats as coloured pieces, drawn in a row by the band and the turn's closing line. */
export function statsSegments(run: Run, now: number): Segment[] {
  const all: Tokens = sumTokens(run.tokens, run.subTokens)
  const rate: number | null = cacheHitRate(all)
  const { calls, errors } = toolTotals(run.tools)
  const sep: Segment = { text: '·', isDim: true }
  const segments: Segment[] = [
    { text: `run #${run.seq} ${STATUS_LABEL[run.status]} ${fmtDuration(elapsed(run, now))}`, color: STATUS_COLOR[run.status] },
    sep,
    { text: `req ${run.requests}${run.subRequests > 0 ? `+${run.subRequests}sub` : ''}` },
    sep,
    { text: `tools ${calls}` },
  ]
  if (errors > 0) segments.push({ text: `✗${errors}`, color: 'red' })
  segments.push(
    sep,
    { text: `in ${fmtTokens(all.input + all.cacheRead + all.cacheWrite)} out ${fmtTokens(all.output)}` },
    sep,
    rate === null ? { text: `cache ${fmtPercent(rate)}` } : { text: `cache ${fmtPercent(rate)}`, color: cacheColor(rate) },
  )
  if (run.costUsd !== null) segments.push(sep, { text: `$${run.costUsd.toFixed(3)}` })
  return segments
}

/**
 * The run a row appended now belongs to. Rows that close a run land around turn.complete
 * without either waiting for the other, so the run is still current or already the last
 * in history.
 */
async function runOfAppend($: EngineInterface): Promise<Run | undefined> {
  return (await read($, current)) ?? (await read($, history)).at(-1)
}

/** Keeps a finished run for drawing: this session's history first, then earlier sessions'. */
async function finishedRun($: EngineInterface, runId: string): Promise<Run | undefined> {
  // A run still finishing is not in history yet; reading history redraws once it lands.
  const found: Run | undefined = (await read($, history)).find(r => r.id === runId)
  if (found !== undefined) return found
  const saved = (await $.store.get(STORE_KEY)) as Run[] | undefined
  return saved?.find(r => r.id === runId)
}

/** Adds key → value to a capped map in the store, so a resumed session can still draw. */
async function storeEntry($: EngineInterface, storeKey: string, key: string, value: string): Promise<void> {
  const saved = (await $.store.get(storeKey)) as Record<string, string> | undefined
  const kept: [string, string][] = Object.entries(saved ?? {})
    .filter(([k]) => k !== key)
    .slice(-(STORE_LIMIT - 1))
  await $.store.set(storeKey, { ...Object.fromEntries(kept), [key]: value })
}

/** What the engine drew, then the run's forecast and stats rows under it. */
function withStats($: EngineInterface, e: ResolveInput<'TurnDuration'>, theirs: RenderElement, run: Run): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const row = (segments: Segment[]) => (
    <Box flexDirection="row" columnGap={1} paddingLeft={2}>
      {segments.map(s => (
        <Text color={s.color} dimColor={s.isDim} wrap="truncate">
          {s.text}
        </Text>
      ))}
    </Box>
  )
  const forecast: Segment[] = weatherSegments(run)

  return (
    <Box flexDirection="column">
      {theirs}
      {forecast.length > 0 && row(forecast)}
      {row(statsSegments(run, run.endedAt ?? run.startedAt))}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'run-status',
      description: 'Show token, cache, request and tool-call stats of each run',
    })
    // Keep the running clock in the band moving.
    $.clock.every(1000, async () => {
      const run: Run | null = await read($, current)
      if (run !== null && run.status === 'running') $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('command.run', { command: 'run-status' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Run status', closeOnEscape: true })

    return {}
  })

  on('turn.start', async ($, e, next) => {
    const [startedAt, costAtStart] = await Promise.all([$.clock.now(), sessionCost($)])
    let n: number = 0
    await update($, seq, v => (n = v + 1))
    const run: Run = {
      id: e.turnId,
      seq: n,
      prompt: e.text.replace(/\s+/g, ' ').trim().slice(0, 120),
      startedAt,
      endedAt: null,
      status: 'running',
      model: null,
      requests: 0,
      subRequests: 0,
      tokens: ZERO,
      subTokens: ZERO,
      tools: [],
      costAtStart,
      costUsd: null,
      contextPercent: null,
      stepInputs: [],
      contextTokens: null,
      contextDelta: null,
    }
    await update($, current, () => run)

    return next(e)
  })

  // Every model request of the run: main-loop ones and those of its subagents.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const usage = r.usage
    const isSub: boolean = e.agentId !== undefined
    await patchRunning($, run =>
      isSub
        ? {
            ...run,
            subRequests: run.subRequests + 1,
            subTokens: usage ? addUsage(run.subTokens, usage) : run.subTokens,
          }
        : {
            ...run,
            requests: run.requests + 1,
            tokens: usage ? addUsage(run.tokens, usage) : run.tokens,
            stepInputs: usage ? [...(run.stepInputs ?? []), promptTokens(usage)] : run.stepInputs,
            model: usage?.model ?? run.model,
          },
    )

    return r
  })

  on('tool.call', async ($, e, next) => {
    const name: string = String(e.tool)
    await patchRunning($, run => ({ ...run, tools: tally(run.tools, name, 'count') }))
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      await patchRunning($, run => ({ ...run, tools: tally(run.tools, name, 'errors') }))
    }

    return ran
  })

  // Remember which turn_duration row closes each run.
  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined && e.message.type === 'system' && e.message.name === 'turn_duration') {
      const run: Run | undefined = await runOfAppend($)
      if (run !== undefined) {
        const runId: string = run.id
        await update($, rows, map => ({ ...map, [e.uuid]: runId }))
        await storeEntry($, ROWS_KEY, e.uuid, runId)
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const run: Run | null = await read($, current)
    if (e.agentId !== undefined || run === null || run.id !== e.turnId) return next(e)

    const [endedAt, usage] = await Promise.all([$.clock.now(), $.session.usage()])
    const costNow: number | null = usage.cost?.usd ?? null
    const contextTokens: number | null = usage.context.tokens ?? null
    const previous: number | null = (await read($, history)).at(-1)?.contextTokens ?? null
    const done: Run = {
      ...run,
      endedAt,
      status: e.reason,
      costUsd: costNow !== null && run.costAtStart !== null ? costNow - run.costAtStart : null,
      contextPercent: usage.context.percent ?? null,
      contextTokens,
      contextDelta: contextTokens !== null && previous !== null ? contextTokens - previous : null,
    }
    await update($, history, list => [...list, done].slice(-HISTORY_LIMIT))
    await update($, current, () => null)
    const saved = (await $.store.get(STORE_KEY)) as Run[] | undefined
    await $.store.set(STORE_KEY, [...(saved ?? []), done].slice(-STORE_LIMIT))

    return next(e)
  })

  // Live stats while a run is going. The terminal then drops the band (the stats move under
  // the turn's closing line); the desktop has no such line, so it keeps the last run here.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const running: Run | null = await read($, current)
    const isLive: boolean = running !== null && running.status === 'running'
    let run: Run | undefined = isLive && running !== null ? running : undefined
    if (run === undefined && e.surface === 'desktop') {
      run = (await read($, history)).at(-1) ?? ((await $.store.get(STORE_KEY)) as Run[] | undefined)?.at(-1)
    }
    if (run === undefined) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now: number = await $.clock.now()
    const forecast: Segment[] = isLive ? [] : weatherSegments(run)
    const sep: Segment[] = forecast.length > 0 ? [{ text: '·', isDim: true }] : []

    return (
      <Box flexDirection="row" columnGap={1}>
        {[...statsSegments(run, now), ...sep, ...forecast].map(s => (
          <Text color={s.color} dimColor={s.isDim} wrap="truncate">
            {s.text}
          </Text>
        ))}
      </Box>
    )
  })

  // The finished run's stats, under the line that closes its turn (terminal only).
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const theirs = await next(e)
    const runId: string | undefined =
      (await read($, rows))[e.requestId] ??
      ((await $.store.get(ROWS_KEY)) as Record<string, string> | undefined)?.[e.requestId]
    const run: Run | undefined = runId === undefined ? undefined : await finishedRun($, runId)

    return run === undefined ? theirs : withStats($, e, theirs, run)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const running: Run | null = await read($, current)
    const list: Run[] = await read($, history)
    const runs: Run[] = running === null ? list : [...list, running]
    if (runs.length === 0) return <Text dimColor>No runs yet in this session.</Text>

    const now: number = await $.clock.now()
    const room: number = Math.max(1, (e.viewport?.rows ?? 24) - 4)

    return (
      <Box flexDirection="column">
        {runs
          .slice()
          .reverse()
          .slice(0, Math.max(1, Math.floor(room / 5)))
          .map(run => {
            const all: Tokens = sumTokens(run.tokens, run.subTokens)
            const rate: number | null = cacheHitRate(all)
            const { calls, errors } = toolTotals(run.tools)
            const topTools: string = [...run.tools]
              .sort((a, b) => b.count - a.count)
              .slice(0, 6)
              .map(t => `${t.name}×${t.count}${t.errors > 0 ? `(✗${t.errors})` : ''}`)
              .join(' ')

            return (
              <Box key={run.id} flexDirection="column" marginBottom={1}>
                <Text wrap="truncate">
                  <Text bold>#{run.seq}</Text>{' '}
                  <Text color={STATUS_COLOR[run.status]}>{STATUS_LABEL[run.status]}</Text>{' '}
                  {fmtDuration(elapsed(run, now))} <Text dimColor>{run.model ?? ''}</Text>
                </Text>
                <Text dimColor wrap="truncate">
                  {run.prompt === '' ? '(no prompt)' : run.prompt}
                </Text>
                <Text wrap="truncate">
                  requests {run.requests}
                  {run.subRequests > 0 ? ` (+${run.subRequests} subagent)` : ''} · tools {calls}
                  {errors > 0 ? ` (${errors} failed)` : ''} · cache{' '}
                  <Text color={cacheColor(rate)}>{fmtPercent(rate)}</Text>
                  {run.costUsd !== null ? ` · $${run.costUsd.toFixed(3)}` : ''}
                  {run.contextPercent !== null ? ` · ctx ${run.contextPercent}%` : ''}
                </Text>
                <Text wrap="truncate">
                  tokens new {fmtTokens(all.input)} · cache-read {fmtTokens(all.cacheRead)} ·
                  cache-write {fmtTokens(all.cacheWrite)} · out {fmtTokens(all.output)}
                  {run.subRequests > 0
                    ? ` (subagent ${fmtTokens(run.subTokens.input + run.subTokens.cacheRead + run.subTokens.cacheWrite)} in / ${fmtTokens(run.subTokens.output)} out)`
                    : ''}
                </Text>
                {topTools !== '' && (
                  <Text dimColor wrap="truncate">
                    {topTools}
                  </Text>
                )}
              </Box>
            )
          })}
      </Box>
    )
  })
}
