import type { Snapshot } from './quota.ts'

export const TTL = 5 * 60_000
const MIN_REFRESH = 60_000

type Entry = { value?: Snapshot; attemptedAt: number; pending?: Promise<Snapshot> }

/** Process-local, credential-scoped quota cache. Failed refreshes retain the observation's original timestamp. */
export function createCache() {
  const entries = new Map<string, Entry>()
  return async (
    key: string,
    load: () => Promise<Snapshot>,
    refresh: boolean,
    now: number,
  ): Promise<Snapshot> => {
    const old = entries.get(key)
    if (old?.pending) return old.pending
    const wait = Math.max(
      refresh ? MIN_REFRESH : TTL,
      (old?.value?.retryAt ?? 0) - (old?.attemptedAt ?? now),
    )
    if (old?.value && now - old.attemptedAt < wait) return old.value
    const entry: Entry = { value: old?.value, attemptedAt: now }
    entry.pending = load().then(
      (value) => {
        entry.value =
          value.status === 'error' && old?.value?.windows.length
            ? {
                ...value,
                windows: old.value.windows,
                checkedAt: old.value.checkedAt,
                partial: old.value.partial,
                limited: old.value.limited,
              }
            : value
        entry.pending = undefined
        return entry.value
      },
      () => {
        entries.delete(key)
        throw new Error('Quota refresh failed.')
      },
    )
    entries.set(key, entry)
    // Each provider has one effective credential. Drop superseded account observations.
    for (const other of entries.keys())
      if (other !== key && other.split(':')[0] === key.split(':')[0]) entries.delete(other)
    return entry.pending
  }
}
