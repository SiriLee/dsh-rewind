/**
 * The client command face: `/rewind`, `/undo`, and the page-level takeover
 * service a third-party UI uses to own that face.
 *
 * The engine contributes its two commands as client commands. A claimant calls
 * `ctx.dshRewind.commands.takeover()`; the engine unregisters every command it
 * contributed and returns a permission. The claimant registers its own
 * commands through the standard `ctx.commandUi.register`; `permission.dispose()`
 * restores the engine's commands, skipping names another plugin still owns.
 *
 * The service is client-only, like the commands themselves: the host half keeps
 * no command takeover channel.
 *
 * @module dsh-rewind/client/command-takeover
 */

import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { UiOwner } from './claim.ts'
import { rewindLog } from './log.ts'

/** Why a command-face takeover was refused. */
export type CommandTakeoverErrorCode = 'already-taken' | 'native-owner'

/**
 * Refusal raised by {@link RewindCommands.takeover}. Branch on `code`; the
 * message is a diagnostic and is not stable.
 */
export class CommandTakeoverError extends Error {
  constructor(readonly code: CommandTakeoverErrorCode) {
    super(`dsh-rewind: command takeover refused (${code})`)
    this.name = 'CommandTakeoverError'
  }
}

/** The handle a successful takeover returns: gives the command face back. */
export interface CommandTakeoverPermission {
  /**
   * Restore the engine's command surface. Idempotent, and a no-op once the
   * client half has unloaded (there is no surface left to restore).
   */
  dispose(): void
}

/** The takeover operation, exposed as `ctx.dshRewind.commands`. */
export interface RewindCommands {
  /**
   * Take the page's command face away from the engine.
   *
   * Resolves after every engine command this page contributed has been
   * unregistered. Refuses with {@link CommandTakeoverError}: `native-owner`
   * when `uiOwner` is `self` (checked before anything else), `already-taken`
   * when another claimant still holds the face.
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

/** One engine command currently registered on the page. */
interface LiveCommand {
  readonly contribution: CommandContribution
  readonly dispose: () => void
}

/** Handed to a caller that raced the client's own unload; owns nothing. */
const INERT_PERMISSION: CommandTakeoverPermission = { dispose() {} }

/**
 * Register the engine's client commands and build the takeover service.
 *
 * A refused registration costs only that command name: another plugin may own
 * it, and the face (plus the rest of the client half) must keep working. The
 * returned `dispose` removes the engine's commands with the client fiber and
 * invalidates any permission still held at that point.
 * @param options - the engine commands plus the standard command registry and
 *   the live owner policy.
 * @returns the exposed service face and its unload hook.
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
        // A stale caller can only race the client's own unload: there is no
        // surface left to withdraw, and no reason to refuse.
        if (disposed) return INERT_PERMISSION
        // `uiOwner: self` is the native-owner escape hatch and outranks an
        // existing claimant: the face was never ours to yield.
        if (options.readOwner() === 'self') throw new CommandTakeoverError('native-owner')
        if (taken) throw new CommandTakeoverError('already-taken')
        const withdrawn = withdraw()
        // An open picker would otherwise stay actionable after its commands
        // left the catalog; close it with the surface it belongs to.
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
            // Only names that were registered before the takeover return; a
            // name the claimant still owns is skipped, never overwritten.
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
