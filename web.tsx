import { useEffect, useState } from 'react'
import { GaugeIcon, RefreshCwIcon, ExternalLinkIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  actionRef,
  api,
  cn,
  defineWebExtension,
  useAction,
  useConversation,
  useModels,
} from '@/sdk'
import {
  configuredSubscriptions,
  preferred,
  providers,
  type Priority,
  type Snapshot,
} from './quota.ts'
import { TTL } from './cache.ts'
import type { Scope } from './scope.ts'

const Quota = actionRef<{ provider: string; refresh?: boolean }, Snapshot>('limits', 'quota')
const ScopeAction = actionRef<null, Scope>('limits', 'scope')
// Keep the browser preference across the preview's extension rename; no quota history is stored.
const PRIORITY_KEY = 'subscription-quota.priority'
const percent = (value: number) => `${value > 0 && value < 1 ? '<1' : Math.floor(value)}%`
const shortLabel = (label: string) =>
  label === '5 hours' ? '5h' : label === '7 days' ? '7d' : label
const providerLabel = (provider: string) =>
  Object.hasOwn(providers, provider)
    ? providers[provider]!.label
    : provider === 'xai'
      ? 'Grok'
      : provider
const localTime = (value: number) =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
const stale = (data: Snapshot, now: number) =>
  data.status === 'error' ||
  now - data.checkedAt >= TTL ||
  data.windows.some((item) => item.resetAt !== undefined && item.resetAt <= now)
function reset(value: number, now: number) {
  const minutes = Math.max(1, Math.ceil((value - now) / 60_000))
  return minutes < 60
    ? `${minutes}m`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
}
function useQuota(provider: string, enabled: boolean) {
  return useAction(
    Quota,
    { provider },
    {
      enabled,
      every: 60_000,
      focus: true,
      onError: () => {
        /* Each quota surface owns its transport-error state, not a global toast. */
      },
    },
  )
}

function Subscription({
  provider,
  current,
  model,
  visible,
  now,
}: {
  provider: string
  current: boolean
  model?: string
  visible: boolean
  now: number
}) {
  const quota = useQuota(provider, visible)
  const data = quota.data?.provider === provider ? quota.data : undefined
  const [refreshing, setRefreshing] = useState(false)
  const [failure, setFailure] = useState(false)
  const old = !!data && (stale(data, now) || !!quota.error || failure)
  const refresh = async () => {
    setRefreshing(true)
    setFailure(false)
    try {
      await api.action(Quota, { provider, refresh: true })
      quota.refetch()
    } catch {
      // Keep this failure local and never render a raw provider error.
      setFailure(true)
    } finally {
      setRefreshing(false)
    }
  }
  const dashboard = Object.hasOwn(providers, provider) ? providers[provider]?.dashboard : undefined
  return (
    <section
      data-quota-provider={provider}
      className={cn('py-3 first:pt-0 last:pb-0', current && 'text-foreground')}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-medium">{providerLabel(provider)}</span>
          {current && <span className="text-[10px] text-brand">Current</span>}
          {data?.limited && <span className="text-[10px] text-warning">Limit reached</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {dashboard && (
            <a
              href={dashboard}
              target="_blank"
              rel="noreferrer"
              aria-label={`${providerLabel(provider)} usage dashboard`}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ExternalLinkIcon className="size-3" />
            </a>
          )}
          {dashboard && (
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing || quota.loading || !visible}
              aria-label={`Refresh ${providerLabel(provider)} quota`}
              title="Refresh (at most once per minute)"
              className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
            >
              <RefreshCwIcon
                className={cn('size-3', (refreshing || quota.loading) && 'animate-spin')}
              />
            </button>
          )}
        </div>
      </div>
      {current && model && (
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={model}>
          {model}
        </div>
      )}
      <div className="mt-2 space-y-2">
        {data?.windows.map((item) => {
          const expired = item.resetAt !== undefined && item.resetAt <= now
          return (
            <div key={item.label}>
              <div className="flex justify-between gap-3">
                <span>{item.label}</span>
                <span
                  className={cn(
                    (old || expired) && 'text-muted-foreground',
                    !old && item.remaining <= 20 && 'text-warning',
                  )}
                >
                  {expired ? 'Awaiting refresh' : `${percent(item.remaining)} left`}
                </span>
              </div>
              <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full',
                    old
                      ? 'bg-muted-foreground/40'
                      : item.remaining <= 5
                        ? 'bg-error'
                        : item.remaining <= 20
                          ? 'bg-warning'
                          : 'bg-brand/70',
                  )}
                  style={{ width: `${expired ? 0 : item.remaining}%` }}
                />
              </div>
              {item.resetAt !== undefined && !expired && (
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  Resets in {reset(item.resetAt, now)} · {localTime(item.resetAt)}
                </div>
              )}
            </div>
          )
        })}
        {!data && (
          <div className="text-[11px] text-muted-foreground">
            {quota.error ? 'Quota could not be loaded.' : 'Reading subscription quota…'}
          </div>
        )}
        {data && data.status !== 'ok' && (
          <div className="text-[11px] text-muted-foreground">{data.detail}</div>
        )}
        {data?.partial && (
          <div className="text-[10px] text-warning">
            Partial: additional model/group limits are not included.
          </div>
        )}
        {(failure || quota.error) && data && (
          <div className="text-[10px] text-warning">Refresh failed; previous reading retained.</div>
        )}
      </div>
      {data && (
        <div className="mt-1.5 text-[10px] text-muted-foreground">
          Read {localTime(data.checkedAt)}
          {old ? ' · stale' : ''}
          {data.retryAt && data.retryAt > now ? ` · retry after ${localTime(data.retryAt)}` : ''}
        </div>
      )}
    </section>
  )
}

function QuotaChip() {
  const provider = useConversation((conversation) => conversation.agent.model?.provider)
  const model = useConversation((conversation) => conversation.agent.model?.modelId)
  const models = useModels()
  const [visible, setVisible] = useState(!document.hidden)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [priority, setPriority] = useState<Priority>(() => {
    try {
      return localStorage.getItem(PRIORITY_KEY) === 'tightest' ? 'tightest' : 'five-hour'
    } catch {
      return 'five-hour' /* Storage can be denied; the default remains usable for this page. */
    }
  })
  const [saveFailed, setSaveFailed] = useState(false)
  useEffect(() => {
    const changed = () => {
      setVisible(!document.hidden)
      setNow(Date.now())
    }
    const storage = (event: StorageEvent) => {
      if (event.key === PRIORITY_KEY)
        setPriority(event.newValue === 'tightest' ? 'tightest' : 'five-hour')
    }
    document.addEventListener('visibilitychange', changed)
    window.addEventListener('storage', storage)
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      document.removeEventListener('visibilitychange', changed)
      window.removeEventListener('storage', storage)
      window.clearInterval(timer)
    }
  }, [])
  const quota = useQuota(provider ?? '', !!provider && visible)
  const data = quota.data?.provider === provider ? quota.data : undefined
  const selected = data && preferred(data, now, priority)
  const old = !!data && (stale(data, now) || !!quota.error)
  const project = useAction(ScopeAction, null, {
    enabled: open && visible,
    every: 60_000,
    focus: true,
    onError: () => {
      /* Scope failures render locally and never fan out auth reads. */
    },
  })
  const subscriptions = configuredSubscriptions(
    models?.providers ?? [],
    project.data?.error ? [] : (project.data?.providers ?? []),
    provider,
  )
  const changePriority = (value: Priority) => {
    setPriority(value)
    try {
      localStorage.setItem(PRIORITY_KEY, value)
      setSaveFailed(false)
    } catch {
      setSaveFailed(true) /* Report non-persistence instead of silently losing the user's choice. */
    }
  }
  if (!provider) return null
  const summary = data?.limited
    ? 'limit reached'
    : selected
      ? `${shortLabel(selected.label)} ${percent(selected.remaining)}`
      : quota.loading
        ? '…'
        : '—'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-ui="limits"
          className={cn(
            'flex shrink-0 items-center gap-1.5 whitespace-nowrap hover:text-foreground transition-colors',
            old && 'opacity-60',
            !old && (data?.limited || (selected && selected.remaining <= 20)) && 'text-warning',
          )}
          title={`Remaining shared quota · ${priority === 'five-hour' ? '5h first' : 'Tightest'}${data?.partial ? ' · partial coverage' : ''}`}
        >
          <GaugeIcon className="size-3" />
          <span>
            {providerLabel(provider)} · {summary}
            {old ? ' · stale' : ''}
            {data?.partial ? ' · partial' : ''}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-[360px] max-w-[calc(100vw-24px)] overflow-hidden p-0 font-mono text-xs"
        data-ui="limits-popover"
      >
        <div className="border-b border-border/70 px-3 py-2.5">
          <div className="font-medium">Subscription limits</div>
          <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
            <label htmlFor="limits-priority">Chip priority</label>
            <select
              id="limits-priority"
              value={priority}
              onChange={(event) =>
                changePriority(event.target.value === 'tightest' ? 'tightest' : 'five-hour')
              }
              className="rounded border border-border/70 bg-popover px-1 py-0.5 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-brand"
            >
              <option value="five-hour">5h first</option>
              <option value="tightest">Tightest</option>
            </select>
          </div>
          {saveFailed && (
            <div className="mt-1 text-[10px] text-warning">
              Preference could not be saved in this browser.
            </div>
          )}
        </div>
        <div className="max-h-[min(65vh,560px)] overflow-y-auto px-3 py-2.5 divide-y divide-border/70">
          {open &&
            subscriptions.map((item) => (
              <Subscription
                key={item.id}
                provider={item.id}
                current={item.id === provider}
                model={model}
                visible={visible}
                now={now}
              />
            ))}
          {!subscriptions.length && (
            <div className="text-muted-foreground">
              {project.error || project.data?.error
                ? 'Project subscriptions could not be resolved.'
                : project.loading
                  ? 'Loading project subscriptions…'
                  : 'No subscriptions used by this project.'}
            </div>
          )}
        </div>
        <div className="border-t border-border/70 px-3 py-2 text-[10px] text-muted-foreground">
          Shared allowances, not remaining model requests.
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.left': [{ component: QuotaChip, order: 1, phone: true }] },
})
