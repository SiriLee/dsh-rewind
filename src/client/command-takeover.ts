/**
 * The client command face: `/rewind`, `/undo`, and the page-level takeover
 * service (`ctx.dshRewind.commands`) a third-party UI uses to own that face.
 * The service is client-only; the host half has no command takeover channel.
 *
 * @module dsh-rewind/client/command-takeover
 */

import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { UiOwner } from './claim.ts'
import { rewindLog } from './log.ts'

/** Why a command-face takeover was refused. */
export type CommandTakeoverErrorCode = 'already-taken' | 'native-owner'

/** Refusal raised by {@link RewindCommands.takeover}; branch on `code`. */
export class CommandTakeoverError extends Error {
  constructor(readonly code: CommandTakeoverErrorCode) {
    super(`dsh-rewind: command takeover refused (${code})`)
    this.name = 'CommandTakeoverError'
  }
}

/** The handle a successful takeover returns. */
export interface CommandTakeoverPermission {
  /** Restore the engine's command surface; idempotent and inert after unload. */
  dispose(): void
}

/** The takeover operation, exposed as `ctx.dshRewind.commands`. */
export interface RewindCommands {
  /**
   * Take the page's command face away from the engine.
   * @returns the permission that restores it.
   * @throws {CommandTakeoverError} `native-owner` under `uiOwner: self`,
   *   `already-taken` while another claimant holds the face.
   */
  takeover(): Promise<CommandTakeoverPermission>
}

/** The `ctx.dshRewind` service face. */
export interface RewindCommandFace {
  readonly commands: RewindCommands
}

/** Inputs the face needs from the client plugin. */
export interface CommandFaceOptions {
  /** The engine's client commands, in registration order. */
  readonly contributions: readonly CommandContribution[]
  /** Standard client command registration; a duplicate name throws. */
  register(contribution: CommandContribution): () => void
  /** Close this command's open popups while the engine withdraws it. */
  dismiss(name: string): void
  /** Read the live `uiOwner` setting (the same switch the action face uses). */
  readOwner(): UiOwner
}

/** The engine-owned face plus the teardown the client fiber runs on unload. */
export interface CommandFace {
  readonly service: RewindCommandFace
  dispose(): void
}

/** One engine command registered on the page. */
interface LiveCommand {
  readonly contribution: CommandContribution
  readonly dispose: () => void
}

/** Handed to a caller that raced the client's own unload; owns nothing. */
const INERT_PERMISSION: CommandTakeoverPermission = { dispose() {} }

/**
 * Register the engine's client commands and build the takeover service.
 * A refused registration costs only that name. The returned `dispose` removes
 * the commands with the client fiber and invalidates a held permission.
 * @param options - the engine commands, the command registry and the owner policy.
 * @returns the exposed service and its unload hook.
 */
export function createCommandFace(options: CommandFaceOptions): CommandFace {
  const live = new Map<string, LiveCommand>()
  let taken = false
  let disposed = false

  /** Register one engine command, containing a refused name. */
  const keep = (contribution: CommandContribution): void => {
    try {
      live.set(contribution.name, { contribution, dispose: options.register(contribution) })
    } catch (error) {
      rewindLog.warn('command', `the ${contribution.name} client command was refused`, error)
    }
  }

  /** Unregister every engine command currently live; returns them in registration order. */
  const withdraw = (): LiveCommand[] => {
    const commands = [...live.values()]
    live.clear()
    for (const command of [...commands].reverse()) {
      try {
        command.dispose()
      } catch (error) {
        rewindLog.warn('command', `the ${command.contribution.name} client command was not removed`, error)
      }
    }
    return commands
  }

  for (const contribution of options.contributions) keep(contribution)

  const service: RewindCommandFace = {
    commands: {
      async takeover(): Promise<CommandTakeoverPermission> {
        // A stale caller can only race our unload; nothing is left to yield.
        if (disposed) return INERT_PERMISSION
        // `native-owner` outranks an existing claimant: the face was never ours.
        if (options.readOwner() === 'self') throw new CommandTakeoverError('native-owner')
        if (taken) throw new CommandTakeoverError('already-taken')
        const withdrawn = withdraw()
        // Close an open picker with the commands it belongs to.
        for (const command of withdrawn) {
          try {
            options.dismiss(command.contribution.name)
          } catch (error) {
            rewindLog.warn('command', `the ${command.contribution.name} command popup was not dismissed`, error)
          }
        }
        taken = true
        let released = false
        return {
          dispose: () => {
            if (released) return
            released = true
            if (disposed || !taken) return
            taken = false
            // Only previously registered names return; an occupied name is
            // skipped by `keep`, never overwritten.
            for (const command of withdrawn) keep(command.contribution)
          },
        }
      },
    },
  }

  return {
    service,
    dispose(): void {
      if (disposed) return
      disposed = true
      taken = false
      withdraw()
    },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The page-level command-face takeover service (client half only). */
    dshRewind: RewindCommandFace
  }
}
