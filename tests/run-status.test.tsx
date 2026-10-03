import { describe, expect, mock, test } from 'claude-code/testing'

import { cacheHitRate, fmtDuration, fmtTokens, sparkline, weatherOf } from '../hooks/register'

const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 }

const BAND = {
  plugin: 'run-status',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 200,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

describe('formatting', () => {
  test('tokens, durations and cache rate', async () => {
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(12_345)).toBe('12.3k')
    expect(fmtTokens(2_500_000)).toBe('2.50M')
    expect(fmtDuration(65_000)).toBe('1m05s')
    expect(cacheHitRate({ input: 100, output: 0, cacheRead: 800, cacheWrite: 100 })).toBe(0.8)
    expect(cacheHitRate({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBe(null)
  })

  test('forecast scale and sparkline', async () => {
    expect([0, 24, 25, 49, 50, 74, 75, 89, 90, 100].map(p => weatherOf(p).word)).toEqual([
      'Clear', 'Clear', 'Cloudy', 'Cloudy', 'Showers', 'Showers', 'Storm', 'Storm', 'Compact soon', 'Compact soon',
    ])
    expect(sparkline([])).toBe('')
    expect(sparkline([300_000, 300_500, 301_000])).toBe('▁▁▂')
    expect(sparkline([100_000, 150_000, 200_000])).toBe('▁▅█')
    expect(sparkline(Array.from({ length: 50 }, (_, i) => i * 1000))).toHaveLength(40)
  })
})

test('one run records requests, tokens, cache rate, tool calls and cost', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  let usd: number = 0.5
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, tokens: 40_000, percent: 20 },
      rateLimits: [],
      cost: { usd },
    },
  }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { ...USAGE, model: 'claude-test' },
    }
  })
  on('tool.call', (_$, e) =>
    e.tool === 'Bash' ? { result: 'boom', text: 'boom', isError: true } : { result: 'ok', text: 'ok' },
  ) as never
  on('turn.complete', () => ({ text: '' }))
  // Stands for the engine's own drawing of each site.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.turn.start({ text: 'fix   the\nbug', turnId: 't1' })
  for (const step of [{ index: 0 }, { index: 1 }, { index: 0, agentId: 'a1' }]) {
    const stream = $.turn.step({ turnId: 't1', model: 'claude-test', messageCount: 3, ...step })
    for await (const _ of stream) {
    }
  }
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/tmp/x' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: 'false' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'u3', file_path: '/tmp/y' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /run #1 ● running 0s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /req 2\+1sub/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'tools 3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✗1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'in 3.0k out 150' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'cache 80%' })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(65_000)
  usd = 0.75
  // The kit has nothing beneath session.append to store the row; the mod records
  // the row id before calling next, which is all this checks.
  await $.session
    .append({
      message: { type: 'system', name: 'turn_duration', isMeta: false, content: [] },
      door: 'notice',
      origin: { kind: 'engine' },
      uuid: 'row-1',
    } as never)
    .catch(() => undefined)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 65_000, isAborted: false })

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /run #1/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()

  const desktopBand = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktopBand.find({ type: 'Text', text: 'run #1 ✓ done 1m05s' })).toMatchObject({ props: { color: 'green' } })
  expect(await desktopBand.find({ type: 'Text', text: '☀ Clear' })).toMatchObject({ props: { color: 'green' } })
  expect(await desktopBand.find({ type: 'Text', text: '▁▁' })).toBeDefined()

  const closing = await $.ui.mount({
    plugin: 'run-status',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId: 'row-1',
    props: { word: 'Baked', durationMs: 65_000 },
  })
  expect(await closing.find({ type: 'Text', text: 'engine' })).toBeDefined()
  expect(await closing.find({ type: 'Text', text: 'run #1 ✓ done 1m05s' })).toMatchObject({ props: { color: 'green' } })
  expect(await closing.find({ type: 'Text', text: '✗1' })).toMatchObject({ props: { color: 'red' } })
  expect(await closing.find({ type: 'Text', text: 'cache 80%' })).toMatchObject({ props: { color: 'green' } })
  expect(await closing.find({ type: 'Text', text: '$0.250' })).toBeDefined()
  expect(await closing.find({ type: 'Text', text: 'ctx 20%' })).toBeDefined()
  expect(await closing.find({ type: 'Text', text: '☀ Clear' })).toMatchObject({ props: { color: 'green' } })
  expect(await closing.find({ type: 'Text', text: '▁▁' })).toBeDefined()
  expect(await closing.find({ type: 'Text', text: /[▲▼]/ })).toBeUndefined()

  const other = await $.ui.mount({
    plugin: 'run-status',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId: 'row-unknown',
    props: { word: 'Baked', durationMs: 1_000 },
  })
  expect(await other.find({ type: 'Text', text: /run #/ })).toBeUndefined()

  const pane = await $.ui.mount({
    plugin: 'run-status',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'run-status',
    props: { title: 'Run status' } as never,
  })
  expect(await pane.find({ type: 'Text', text: 'fix the bug' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Read×2 Bash×1\(✗1\)/ })).toBeDefined()
})

test('a subagent turn.complete does not close the main run', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 'sub', agentId: 'a1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /● running/ })).toBeDefined()
})

test('the closing row maps to its run when it lands after turn.complete', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', reason: 'aborted', answer: '', durationMs: 1, isAborted: true })
  // See the first test: nothing beneath stores the row.
  await $.session
    .append({
      message: { type: 'system', name: 'turn_duration', isMeta: false, content: [] },
      door: 'notice',
      origin: { kind: 'engine' },
      uuid: 'row-late',
    } as never)
    .catch(() => undefined)

  const closing = await $.ui.mount({
    plugin: 'run-status',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId: 'row-late',
    props: { word: 'Baked', durationMs: 1 },
  })
  expect(await closing.find({ type: 'Text', text: /run #1 ■ aborted/ })).toMatchObject({ props: { color: 'yellow' } })
})

test('the forecast shows how much the run grew the context', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  let tokens: number = 40_000
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens, percent: Math.round((tokens / 200_000) * 100) }, rateLimits: [] },
  }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  for (const turnId of ['t1', 't2']) {
    await $.turn.start({ text: 'go', turnId })
    await $.session
      .append({
        message: { type: 'system', name: 'turn_duration', isMeta: false, content: [] },
        door: 'notice',
        origin: { kind: 'engine' },
        uuid: `row-${turnId}`,
      } as never)
      .catch(() => undefined)
    await $.turn.complete({ turnId, reason: 'answer', answer: '', durationMs: 1, isAborted: false })
    tokens = 160_000
  }

  const closing = await $.ui.mount({
    plugin: 'run-status',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId: 'row-t2',
    props: { word: 'Baked', durationMs: 1 },
  })
  expect(await closing.find({ type: 'Text', text: '☇ Storm' })).toMatchObject({ props: { color: 'red' } })
  expect(await closing.find({ type: 'Text', text: '▲+120.0k' })).toMatchObject({ props: { color: 'yellow' } })
})

test('a new desktop session shows the last stored run; the terminal shows nothing', async ($, on) => {
  const stored = {
    id: 'old', seq: 9, prompt: 'earlier', startedAt: 0, endedAt: 20_000, status: 'answer', model: 'claude-test',
    requests: 2, subRequests: 0, tokens: { input: 10, output: 5, cacheRead: 990, cacheWrite: 0 },
    subTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: [], costAtStart: 1, costUsd: 0.1,
    contextPercent: 60, contextTokens: 120_000, contextDelta: 5_000, stepInputs: [100_000, 120_000],
  }
  mock.clock(on)
  mock.store(on, { runs: [stored] })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: 'run #9 ✓ done 20s' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: '☂ Showers' })).toMatchObject({ props: { color: 'yellow' } })
  expect(await desktop.find({ type: 'Text', text: '▲+5.0k' })).toBeDefined()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: /run #/ })).toBeUndefined()
})
