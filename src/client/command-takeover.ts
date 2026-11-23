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

/** Why a takeover was refused; diagnostic only, never thrown or exported. */
type TakeoverRefusal = 'native-owner' | 'already-taken' | 'withdraw-failed' | 'unloaded'

/** Log one refused takeover. Callers branch on `null`, not on this reason. */
function logRefusal(reason: TakeoverRefusal): void {
  rewindLog.warn('command', `the command takeover was not granted: ${reason}`)
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
   * @returns the permission that restores it, or `null` when the takeover was
   *   refused (the reason is logged and is not part of the API).
   */
  takeover(): Promise<CommandTakeoverPermission | null>
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

  /**
   * Unregister every engine command currently live; returns them in registration
   * order. A failed removal returns `undefined`; when `restore` is set, the
   * commands that were actually removed are put back first (best effort).
   */
  const withdraw = (restore: boolean): LiveCommand[] | undefined => {
    const commands = [...live.values()]
    const failed: LiveCommand[] = []
    for (const command of [...commands].reverse()) {
      try {
        command.dispose()
        live.delete(command.contribution.name)
      } catch (error) {
        failed.push(command)
        rewindLog.warn('command', `the ${command.contribution.name} client command was not removed`, error)
      }
    }
    if (failed.length === 0) return commands
    if (restore) {
      for (const command of commands) {
        if (!failed.includes(command)) keep(command.contribution)
      }
    }
    return undefined
  }

  for (const contribution of options.contributions) keep(contribution)

  const service: RewindCommandFace = {
    commands: {
      async takeover(): Promise<CommandTakeoverPermission | null> {
        // A stale caller can only race our unload; there is nothing to take.
        if (disposed) {
          logRefusal('unloaded')
          return null
        }
        // `native-owner` outranks an existing claimant: the face was never ours.
        if (options.readOwner() === 'self') {
          logRefusal('native-owner')
          return null
        }
        if (taken) {
          logRefusal('already-taken')
          return null
        }
        const withdrawn = withdraw(true)
        if (withdrawn === undefined) {
          logRefusal('withdraw-failed')
          return null
        }
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
      withdraw(false)
    },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The page-level command-face takeover service (client half only). */
    dshRewind: RewindCommandFace
  }
}
