import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScopedReader, projectProviders, type Families } from '../scope.ts'
import { createReader, type Host } from '../client.ts'

const project: Families = {
  families: [
    { name: 'default', follows: 'openai-codex/example' },
    { name: 'fast', model: 'opencode-go/example' },
    { name: 'unused', model: 'anthropic/example' },
  ],
  users: [{ family: 'default' }, { family: 'fast' }, { pinned: 'off' }],
}

test('scope uses effective agent/feature references, not unused families or globally stored logins', () => {
  assert.deepEqual(projectProviders(project), ['openai-codex', 'opencode-go'])
  assert.deepEqual(projectProviders(project, 'anthropic'), [
    'openai-codex',
    'opencode-go',
    'anthropic',
  ])
  assert.deepEqual(projectProviders({ ...project, users: [{ pinned: 'anthropic/pinned' }] }), [
    'anthropic',
  ])
  assert.deepEqual(projectProviders({ ...project, users: [{ family: 'unassigned-model' }] }), [
    'openai-codex',
  ])
})

test('server rejects other-project quota reads and unresolved scope before auth or HTTP', async () => {
  let auth = 0
  let http = 0
  const host: Host = {
    modelRuntime: {
      isUsingOAuth: () => true,
      getProvider: () => ({ baseUrl: 'https://opencode.ai' }),
      getAuth: async () => {
        auth++
        return { auth: { apiKey: 'fixture' } }
      },
    },
  }
  const read = createReader(host, async () => {
    http++
    return Response.json({ usage: { rolling: { percent: 10 } } })
  })
  const scoped = createScopedReader(async () => ({ providers: projectProviders(project) }), read)
  assert.equal((await scoped('anthropic', false)).status, 'unavailable')
  assert.equal((await scoped('xai', false)).status, 'unavailable')
  assert.equal(auth, 0)
  assert.equal(http, 0)
  assert.equal((await scoped('opencode-go', false)).status, 'ok')
  assert.equal(auth, 1)
  assert.equal(http, 1)
  const blocked = createScopedReader(
    async () => ({ providers: [], error: 'Project subscriptions could not be resolved.' }),
    read,
  )
  assert.equal(
    (await blocked('anthropic', true)).detail,
    'Project subscriptions could not be resolved.',
  )
  assert.equal(auth, 1)
})
