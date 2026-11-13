import { unavailable, type Snapshot } from './quota.ts'

export type Families = {
  families: { name: string; model?: string; follows?: string }[]
  users: { family?: string; pinned?: string }[]
}

/** Resolve only the families actually used by this project's agents/features, plus its shown conversation. */
export function projectProviders(view: Families, current?: string): string[] {
  const result = new Set<string>()
  const fallback = view.families.find((item) => item.name === 'default')
  for (const user of view.users) {
    const family = view.families.find((item) => item.name === (user.family ?? 'default'))
    const ref =
      user.pinned ?? family?.model ?? family?.follows ?? fallback?.model ?? fallback?.follows
    if (ref && ref.includes('/')) result.add(ref.slice(0, ref.indexOf('/')))
  }
  if (current) result.add(current)
  return [...result]
}

export type Scope = { providers: string[]; error?: string }
export function createScopedReader(
  scope: (conversationId?: number) => Promise<Scope>,
  read: (provider: string, refresh?: boolean) => Promise<Snapshot>,
) {
  return async (provider: string, refresh: boolean, conversationId?: number) => {
    const allowed = await scope(conversationId)
    if (allowed.error || !allowed.providers.includes(provider)) {
      return unavailable(
        provider,
        Date.now(),
        allowed.error ?? 'This subscription is not used by the current project.',
      )
    }
    return read(provider, refresh)
  }
}
