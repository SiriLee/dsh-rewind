/**
 * Command-face takeover probes: `/rewind` and `/undo` leave the catalog on
 * takeover, a permission restores them in order, and every refusal is one of
 * the two named codes. The registry is the standard `commandUi.register`
 * contract (duplicate names throw), not the engine's implementation.
 */
import { describe, expect, it } from 'vitest'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import {
  CommandTakeoverError,
  createCommandFace,
  type CommandFace,
} from '../src/client/command-takeover.ts'
import type { UiOwner } from '../src/client/claim.ts'

/** One minimal client contribution; the face only reads its name. */
function contribution(name: string): CommandContribution {
  return {
    name,
    available: () => true,
    ui: { kind: 'action', run: () => {} },
  }
}

/** A face over a registry that behaves like `commandUi.register`. */
function makeFace(options: { readonly owner?: UiOwner; readonly refuse?: string } = {}) {
  const registered = new Map<string, CommandContribution>()
  const dismissed: string[] = []
  const face: CommandFace = createCommandFace({
    contributions: [contribution('rewind'), contribution('undo')],
    register: (entry) => {
      if (entry.name === options.refuse) throw new Error(`duplicate contribution for /${entry.name}`)
      if (registered.has(entry.name)) throw new Error(`duplicate contribution for /${entry.name}`)
      registered.set(entry.name, entry)
      return () => { registered.delete(entry.name) }
    },
    dismiss: name => { dismissed.push(name) },
    readOwner: () => options.owner ?? 'auto',
  })
  return { face, registered, dismissed, names: (): string[] => [...registered.keys()] }
}

describe('command-face takeover', () => {
  it('registers both engine commands by default', () => {
    const { names } = makeFace()
    expect(names()).toEqual(['rewind', 'undo'])
  })

  it('withdraws every engine command and supports hide-only', async () => {
    const { face, names, dismissed } = makeFace()
    const permission = await face.service.commands.takeover()
    // Hide-only: the engine withdraws its commands and registers nothing.
    expect(names()).toEqual([])
    expect(dismissed).toEqual(['rewind', 'undo'])
    expect(permission.dispose).toBeTypeOf('function')
  })

  it('refuses a second takeover while one is held', async () => {
    const { face } = makeFace()
    await face.service.commands.takeover()
    await expect(face.service.commands.takeover()).rejects.toMatchObject({
      name: 'CommandTakeoverError',
      code: 'already-taken',
    })
  })

  it('refuses under uiOwner self and leaves the commands in place', async () => {
    const { face, names } = makeFace({ owner: 'self' })
    const error = await face.service.commands.takeover().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CommandTakeoverError)
    expect((error as CommandTakeoverError).code).toBe('native-owner')
    expect(names()).toEqual(['rewind', 'undo'])
  })

  it('gives native ownership precedence over an active claimant', async () => {
    let owner: UiOwner = 'auto'
    const registered = new Map<string, CommandContribution>()
    const face = createCommandFace({
      contributions: [contribution('rewind'), contribution('undo')],
      register: (entry) => {
        registered.set(entry.name, entry)
        return () => { registered.delete(entry.name) }
      },
      dismiss: () => {},
      readOwner: () => owner,
    })
    await face.service.commands.takeover()
    owner = 'self'
    await expect(face.service.commands.takeover()).rejects.toMatchObject({ code: 'native-owner' })
  })

  it('restores the engine commands on permission.dispose, in registration order', async () => {
    const { face, names } = makeFace()
    const permission = await face.service.commands.takeover()
    permission.dispose()
    expect(names()).toEqual(['rewind', 'undo'])
    // Idempotent: a second dispose does not invent duplicates.
    permission.dispose()
    expect(names()).toEqual(['rewind', 'undo'])
  })

  it('skips a name another plugin owns when it restores', async () => {
    const { face, registered, names } = makeFace()
    const permission = await face.service.commands.takeover()
    const taken = contribution('rewind')
    registered.set('rewind', taken)
    permission.dispose()
    // The occupant stays; the free engine command comes back.
    expect(registered.get('rewind')).toBe(taken)
    expect(names()).toEqual(['rewind', 'undo'])
  })

  it('costs only one name when the registry refuses an engine command', async () => {
    const { face, names, dismissed } = makeFace({ refuse: 'rewind' })
    expect(names()).toEqual(['undo'])
    const permission = await face.service.commands.takeover()
    expect(dismissed).toEqual(['undo'])
    permission.dispose()
    expect(names()).toEqual(['undo'])
  })

  it('removes the commands with the client half and invalidates a held permission', async () => {
    const { face, names } = makeFace()
    const permission = await face.service.commands.takeover()
    face.dispose()
    expect(names()).toEqual([])
    // There is no surface left to restore; the late dispose is a no-op.
    permission.dispose()
    expect(names()).toEqual([])
  })

  it('removes the commands on unload without a takeover', () => {
    const { face, names } = makeFace()
    face.dispose()
    expect(names()).toEqual([])
  })

  it('hands a stale caller an inert permission after unload', async () => {
    const { face, names } = makeFace()
    face.dispose()
    const permission = await face.service.commands.takeover()
    expect(() => { permission.dispose() }).not.toThrow()
    expect(names()).toEqual([])
  })
})
