export type Window = { label: string; remaining: number; resetAt?: number }
export type Snapshot = {
  provider: string
  label: string
  status: 'ok' | 'unavailable' | 'error'
  detail: string
  windows: Window[]
  checkedAt: number
  partial?: boolean
  limited?: boolean
  retryAt?: number
}

export const providers: Record<
  string,
  { label: string; url: string; origin: string; dashboard: string }
> = {
  'openai-codex': {
    label: 'Codex',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    origin: 'https://chatgpt.com',
    dashboard: 'https://chatgpt.com/codex/settings/usage',
  },
  anthropic: {
    label: 'Claude',
    url: 'https://api.anthropic.com/api/oauth/usage',
    origin: 'https://api.anthropic.com',
    dashboard: 'https://claude.ai/settings/usage',
  },
  'opencode-go': {
    label: 'Go',
    url: 'https://opencode.ai/zen/go/v1/usage',
    origin: 'https://opencode.ai',
    dashboard: 'https://opencode.ai/console',
  },
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const date = (value: unknown): number | undefined => {
  const result = typeof value === 'string' ? Date.parse(value) : undefined
  return result !== undefined && Number.isFinite(result) ? result : undefined
}
function window(label: string, used: unknown, resetAt?: number): Window | undefined {
  const percent = number(used)
  if (percent === undefined || percent < 0 || percent > 100) return undefined
  return { label, remaining: 100 - percent, ...(resetAt === undefined ? {} : { resetAt }) }
}

// Contract references: openai/codex 69231e1 backend-client/src/client.rs;
// CodexBar 7447bc7 ClaudeOAuthUsageFetcher.swift; anomalyco/opencode ba77ff9 usage-limits.ts.
// Endpoints are not a stable public API. Never turn an absent/malformed window into unused quota.
export function parse(provider: string, value: unknown, now: number): Snapshot {
  const body = object(value)
  const windows: Window[] = []
  let partial = false
  let limited = false
  const add = (item: Window | undefined) => {
    if (item) windows.push(item)
    else partial = true
  }
  if (provider === 'openai-codex') {
    const rate = object(body?.rate_limit)
    limited = rate?.limit_reached === true || rate?.allowed === false
    for (const key of ['primary_window', 'secondary_window']) {
      const item = object(rate?.[key])
      if (!item) continue
      const seconds = number(item.limit_window_seconds)
      const label =
        seconds === 18000
          ? '5 hours'
          : seconds === 604800
            ? '7 days'
            : seconds && seconds > 0
              ? `${Math.round(seconds / 3600)} hours`
              : 'Shared window'
      const reset = number(item.reset_at)
      add(window(label, item.used_percent, reset === undefined ? undefined : reset * 1000))
    }
    partial ||=
      Array.isArray(body?.additional_rate_limits) && body.additional_rate_limits.length > 0
  } else if (provider === 'anthropic') {
    for (const [key, label] of [
      ['five_hour', '5 hours'],
      ['seven_day', '7 days'],
    ]) {
      const item = object(body?.[key!])
      if (item) add(window(label!, item.utilization, date(item.resets_at)))
    }
    // Model/group quotas are not interchangeable with the shared allowance.
    partial ||=
      !!body &&
      Object.keys(body).some(
        (key) =>
          (key.startsWith('seven_day_') && body[key] != null) ||
          (key === 'limits' &&
            (Array.isArray(body[key]) ? body[key].length > 0 : body[key] != null)),
      )
  } else if (provider === 'opencode-go') {
    const usage = object(body?.usage)
    for (const [key, label] of [
      ['rolling', '5 hours'],
      ['weekly', '7 days'],
      ['monthly', 'Month'],
    ]) {
      const item = object(usage?.[key!])
      if (item) {
        add(window(label!, item.percent, date(item.resetsAt)))
        limited ||= item.status === 'rate-limited'
      }
    }
  }
  return {
    provider,
    label: providers[provider]?.label ?? provider,
    checkedAt: now,
    windows,
    status: windows.length ? 'ok' : 'unavailable',
    partial,
    limited: limited || windows.some((item) => item.remaining === 0),
    detail: limited
      ? 'The provider reports a reached subscription limit.'
      : windows.length
        ? 'Shared subscription quota'
        : 'The provider did not return recognized quota windows.',
  }
}

export function unavailable(provider: string, now: number, detail: string): Snapshot {
  return {
    provider,
    label: providers[provider]?.label ?? (provider === 'xai' ? 'Grok' : provider),
    status: 'unavailable',
    detail,
    windows: [],
    checkedAt: now,
  }
}

export function displayed(snapshot: Snapshot, now: number): Window[] {
  return snapshot.windows.filter((item) => item.resetAt === undefined || item.resetAt > now)
}

export type Priority = 'five-hour' | 'tightest'

export function configuredSubscriptions<
  T extends { id: string; status: { configured: boolean }; isUsingSubscription: boolean },
>(items: readonly T[], used: readonly string[], current?: string): T[] {
  return items
    .filter(
      (item) =>
        used.includes(item.id) &&
        item.status.configured &&
        (item.isUsingSubscription || item.id === 'opencode-go'),
    )
    .sort((a, b) => Number(b.id === current) - Number(a.id === current))
}

export function preferred(snapshot: Snapshot, now: number, priority: Priority): Window | undefined {
  const windows = displayed(snapshot, now)
  if (priority === 'tightest')
    return windows.find((item) => item.remaining === remaining(snapshot, now))
  return windows.find((item) => item.label === '5 hours') ?? windows[0]
}

export function remaining(snapshot: Snapshot, now: number): number | undefined {
  const windows = displayed(snapshot, now)
  return windows.length ? Math.min(...windows.map((item) => item.remaining)) : undefined
}
