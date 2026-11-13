import { createHash } from 'node:crypto'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createCache, TTL } from './cache.ts'
import { parse, providers, unavailable, type Snapshot } from './quota.ts'

export type Host = {
  modelRuntime: Pick<ModelRuntime, 'getAuth' | 'isUsingOAuth'> & {
    getProvider(provider: string): { baseUrl?: string } | undefined
  }
}

export function createReader(host: Host, request: typeof fetch = fetch, clock = Date.now) {
  const cached = createCache()
  const authFailures = new Map<string, Snapshot>()
  return async (provider: string, refresh = false): Promise<Snapshot> => {
    const now = clock()
    const config = Object.hasOwn(providers, provider) ? providers[provider] : undefined
    if (!config)
      return unavailable(
        provider,
        now,
        provider === 'xai'
          ? 'Grok Build billing is not verified for Ultimate’s xAI API route.'
          : 'No subscription quota source for this provider.',
      )
    if (provider !== 'opencode-go' && !host.modelRuntime.isUsingOAuth(provider))
      return unavailable(
        provider,
        now,
        'Subscription OAuth is required. API billing is not subscription quota.',
      )
    // A real auth-resolution failure must not turn visible-page polling into a refresh-token retry loop.
    const failed = authFailures.get(provider)
    if (failed && now - failed.checkedAt < (refresh ? 60_000 : TTL)) return failed
    const signal = AbortSignal.timeout(10_000)
    let stage = 'Provider authentication could not be resolved.'
    try {
      const auth = await host.modelRuntime.getAuth(provider, { signal })
      authFailures.delete(provider)
      if (!auth?.auth.apiKey)
        return unavailable(provider, now, 'Existing provider authentication is unavailable.')
      const origin = new URL(
        auth.auth.baseUrl ?? host.modelRuntime.getProvider(provider)?.baseUrl ?? config.origin,
      ).origin
      if (origin !== config.origin)
        return unavailable(
          provider,
          now,
          'Custom provider routes are not supported by this quota source.',
        )
      const headers: Record<string, string> = {
        Authorization: `Bearer ${auth.auth.apiKey}`,
        Accept: 'application/json',
      }
      if (provider === 'anthropic') headers['anthropic-beta'] = 'oauth-2025-04-20'
      if (provider === 'openai-codex') {
        // Account scope comes only from this active credential, never a second auth file.
        const claims = JSON.parse(
          Buffer.from(auth.auth.apiKey.split('.')[1] ?? '', 'base64url').toString(),
        )
        const account =
          auth.auth.headers?.['ChatGPT-Account-Id'] ??
          claims['https://api.openai.com/auth']?.chatgpt_account_id
        if (typeof account !== 'string' || !account)
          return unavailable(provider, now, 'The active credential has no account scope.')
        headers['ChatGPT-Account-Id'] = account
      }
      const key = `${provider}:${createHash('sha256').update(JSON.stringify(headers)).digest('hex')}`
      return await cached(
        key,
        async () => {
          stage = 'Quota request failed. Try again later.'
          try {
            // Keep one bounded request alive when another tab shares it or the conversation switches.
            const response = await request(config.url, { headers, signal, redirect: 'error' })
            if (!response.ok) {
              await response.body?.cancel()
              const retry = response.headers.get('retry-after')
              const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : undefined
              const retryAt =
                seconds === undefined
                  ? retry
                    ? Date.parse(retry)
                    : undefined
                  : clock() + seconds * 1000
              return {
                ...unavailable(provider, now, `Quota endpoint returned HTTP ${response.status}.`),
                status: 'error',
                ...(Number.isFinite(retryAt) ? { retryAt } : {}),
              }
            }
            if (!response.body)
              return unavailable(provider, now, 'Quota endpoint returned no data.')
            const reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            let size = 0
            try {
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                size += value.byteLength
                if (size > 256 * 1024)
                  return unavailable(provider, now, 'Quota response exceeded the size limit.')
                chunks.push(value)
              }
            } finally {
              await reader.cancel()
            }
            stage = 'Quota endpoint returned invalid JSON.'
            return parse(provider, JSON.parse(Buffer.concat(chunks).toString()), clock())
          } catch {
            // Raw errors may contain credentials or response bodies; publish only the known stage.
            return { ...unavailable(provider, now, stage), status: 'error' }
          }
        },
        refresh,
        now,
      )
    } catch {
      // Auth-runtime errors can contain credentials; never log or forward them.
      const result: Snapshot = { ...unavailable(provider, now, stage), status: 'error' }
      authFailures.set(provider, result)
      return result
    }
  }
}
