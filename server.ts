import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { AgentDoc, defineExtension } from '@earendil-works/pi-durable'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { createReader, type Host } from './client.ts'
import { createScopedReader, projectProviders, type Families, type Scope } from './scope.ts'

type ScopeHost = Host & {
  invoke(
    name: string,
    action: string,
    args: null,
    signal: AbortSignal,
    conversationId?: number,
  ): Promise<unknown>
  harness(): Pick<Harness, 'snapshot'>
}
let scope: (conversationId?: number) => Promise<Scope>
let read: ReturnType<typeof createScopedReader>
export default (host: ScopeHost) => {
  scope = async (conversationId) => {
    try {
      const view = (await host.invoke(
        'models',
        'families',
        null,
        AbortSignal.timeout(10_000),
        conversationId,
      )) as Families & { errors: string[] }
      if (!Array.isArray(view.families) || !Array.isArray(view.users) || view.errors?.length)
        throw new Error('Project model configuration is unavailable.')
      const agent =
        conversationId === undefined
          ? undefined
          : await host.harness().snapshot(AgentDoc, conversationId as ConversationId, context)
      return { providers: projectProviders(view, agent?.model?.provider) }
    } catch {
      // Scope failure must stop quota/auth reads; upstream errors can contain private settings.
      return { providers: [], error: 'Project subscriptions could not be resolved.' }
    }
  }
  read = createScopedReader(scope, createReader(host))
  return defineExtension({ name: 'limits' })
}

export const actions = {
  async scope(_args: unknown, ctx: { conversationId?: number }) {
    return scope(ctx.conversationId)
  },
  async quota(args: unknown, ctx: { conversationId?: number }) {
    if (
      !args ||
      typeof args !== 'object' ||
      !('provider' in args) ||
      typeof args.provider !== 'string' ||
      args.provider.length > 100
    )
      throw new Error('A provider id is required.')
    return read(args.provider, 'refresh' in args && args.refresh === true, ctx.conversationId)
  },
}
