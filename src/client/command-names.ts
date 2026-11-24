/** The engine's primary command name. */
export const REWIND = 'rewind' as const

/** The engine's alias command name. */
export const UNDO = 'undo' as const

/** The engine's client command names, shared by the command face and the Host gate. */
export const REWIND_COMMANDS = [REWIND, UNDO] as const

/** One engine command name. */
export type RewindCommand = (typeof REWIND_COMMANDS)[number]
