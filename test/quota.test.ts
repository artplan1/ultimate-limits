import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configuredSubscriptions, parse, preferred } from '../quota.ts'
import { createReader, type Host } from '../client.ts'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const RESET = '2026-11-14T12:00:00Z'

test('Codex weekly-only plans keep their reported duration and expire without invented replenishment', () => {
  const quota = parse(
    'openai-codex',
    {
      rate_limit: {
        primary_window: {
          used_percent: 32,
          limit_window_seconds: 604800,
          reset_at: Date.parse(RESET) / 1000,
        },
      },
    },
    NOW,
  )
  assert.deepEqual(quota.windows, [{ label: '7 days', remaining: 68, resetAt: Date.parse(RESET) }])
  assert.equal(preferred(quota, Date.parse(RESET)), undefined)
})

test('Claude separates shared quota from additional model/group limits', () => {
  const quota = parse(
    'anthropic',
    {
      five_hour: { utilization: 37, resets_at: RESET },
      seven_day: { utilization: 8, resets_at: RESET },
      seven_day_opus: { utilization: 99, resets_at: RESET },
    },
    NOW,
  )
  assert.deepEqual(
    quota.windows.map((item) => item.remaining),
    [63, 92],
  )
  assert.equal(quota.partial, true)
})

test('Go parses percentage units, not fractions or API spend estimates', () => {
  const quota = parse(
    'opencode-go',
    {
      usage: {
        rolling: { percent: 0.5, resetsAt: RESET },
        weekly: { percent: 91, resetsAt: RESET },
        monthly: { percent: 45, resetsAt: RESET },
      },
    },
    NOW,
  )
  assert.deepEqual(
    quota.windows.map((item) => item.remaining),
    [99.5, 9, 55],
  )
  assert.equal(parse('opencode-go', { balance: 42 }, NOW).status, 'unavailable')
  assert.equal(parse('anthropic', { five_hour: { utilization: null } }, NOW).windows.length, 0)
})

test('chip shows the five-hour window before weekly and monthly, and never clears another exhausted window', () => {
  const quota = parse(
    'opencode-go',
    {
      usage: {
        rolling: { percent: 0, resetsAt: RESET },
        weekly: { percent: 91, resetsAt: RESET },
        monthly: { percent: 45, resetsAt: RESET },
      },
    },
    NOW,
  )
  assert.equal(preferred(quota, NOW)?.label, '5 hours')
  const expired = {
    ...quota,
    windows: quota.windows.map((item) =>
      item.label === '5 hours' ? { ...item, resetAt: NOW } : item,
    ),
  }
  assert.equal(preferred(expired, NOW)?.label, '7 days')
  const weeklyOnly = parse(
    'openai-codex',
    { rate_limit: { primary_window: { used_percent: 32, limit_window_seconds: 604800 } } },
    NOW,
  )
  assert.equal(preferred(weeklyOnly, NOW)?.label, '7 days')
  const monthlyOnly = { ...quota, windows: quota.windows.filter((item) => item.label === 'Month') }
  assert.equal(preferred(monthlyOnly, NOW)?.label, 'Month')
  const blocked = parse(
    'opencode-go',
    {
      usage: {
        rolling: { percent: 0, resetsAt: RESET },
        weekly: { percent: 100, status: 'rate-limited', resetsAt: RESET },
      },
    },
    NOW,
  )
  assert.equal(preferred(blocked, NOW)?.remaining, 100)
  assert.equal(blocked.limited, true)
})

test('popup lists this project’s subscriptions independently of current provider, excluding other projects and API billing', () => {
  const item = (id: string, configured: boolean, isUsingSubscription: boolean) => ({
    id,
    status: { configured },
    isUsingSubscription,
  })
  const metadata = [
    item('anthropic', true, true),
    item('openai-codex', true, true),
    item('opencode-go', true, false),
    item('xai', true, true),
    item('openai', true, false),
    item('claude-code', false, true),
  ]
  assert.deepEqual(
    configuredSubscriptions(
      metadata,
      ['openai-codex', 'opencode-go', 'openai', 'claude-code'],
      'opencode-go',
    ).map((item) => item.id),
    ['opencode-go', 'openai-codex'],
  )
  assert.deepEqual(
    configuredSubscriptions(metadata, ['openai-codex', 'opencode-go'], 'openai-codex').map(
      (item) => item.id,
    ),
    ['openai-codex', 'opencode-go'],
  )
})

function runtime(key: () => string): Host {
  return {
    modelRuntime: {
      getAuth: async () => ({ auth: { apiKey: key() } }),
      isUsingOAuth: () => true,
      getProvider: () => ({ baseUrl: 'https://opencode.ai' }),
    },
  }
}
const goBody = (percent: number) => ({ usage: { rolling: { percent, resetsAt: RESET } } })

test('read-only action path coalesces quota requests, honors cooldown and does not reuse another credential’s observation', async () => {
  let now = NOW
  let key = 'fixture-account-a'
  let requests = 0
  const read = createReader(
    runtime(() => key),
    async (url, init) => {
      requests++
      assert.equal(url, 'https://opencode.ai/zen/go/v1/usage')
      assert.equal(init?.method, undefined)
      assert.equal(init?.redirect, 'error')
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${key}`)
      return Response.json(goBody(requests === 1 ? 91 : 20))
    },
    () => now,
  )
  const [first, other] = await Promise.all([read('opencode-go'), read('opencode-go')])
  assert.equal(requests, 1)
  assert.deepEqual(first, other)
  assert.equal(JSON.stringify(first).includes(key), false)
  await read('opencode-go', true)
  assert.equal(requests, 1)
  now += 60_000
  await read('opencode-go', true)
  assert.equal(requests, 2)
  key = 'fixture-account-b'
  await read('opencode-go')
  assert.equal(requests, 3)
})

test('failed refresh retains old quota timestamp, not a fake fresh or zero observation', async () => {
  let now = NOW
  let fail = false
  const read = createReader(
    runtime(() => 'fixture'),
    async () =>
      fail
        ? new Response('', { status: 429, headers: { 'retry-after': '600' } })
        : Response.json(goBody(91)),
    () => now,
  )
  await read('opencode-go')
  now += 300_000
  fail = true
  const result = await read('opencode-go')
  assert.equal(result.status, 'error')
  assert.equal(result.checkedAt, NOW)
  assert.equal(result.windows[0]?.remaining, 9)
  assert.equal(result.retryAt, now + 600_000)
})

test('unverified routes and auth failures return safe states without model calls or raw errors', async () => {
  let requests = 0
  const host = runtime(() => 'fixture')
  let authCalls = 0
  host.modelRuntime.getAuth = async () => {
    authCalls++
    throw new Error('secret-bearing runtime diagnostic')
  }
  const read = createReader(
    host,
    async () => {
      requests++
      return Response.json({})
    },
    () => NOW,
  )
  assert.equal((await read('xai')).status, 'unavailable')
  assert.equal((await read('__proto__')).status, 'unavailable')
  const result = await read('anthropic')
  assert.equal(result.detail, 'Provider authentication could not be resolved.')
  await read('anthropic')
  assert.equal(authCalls, 1)
  assert.equal(JSON.stringify(result).includes('secret-bearing'), false)
  assert.equal(requests, 0)
})
