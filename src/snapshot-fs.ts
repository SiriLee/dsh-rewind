/**
 * Filesystem primitives for the checkpoint store.
 *
 * Every operation that can touch the real file system lives here: atomic JSON
 * writes (temp + rename), streaming byte comparisons (never a whole file in
 * memory), the on-disk probe that classifies links and non-regular targets,
 * and the containment checks that keep a restore inside the location it
 * recorded. Nothing here holds state; the store passes in what it needs.
 *
 * @module dsh-rewind/snapshot-fs
 */

import type { Stats } from 'node:fs'
import { copyFile, lstat, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import { PENDING_DIR, type ByteSource, type CopyOutcome, type DiskProbe } from './snapshot-format.ts'

/** Chunk size of the streaming byte comparisons (never load a whole file). */
const COMPARE_CHUNK_BYTES = 64 * 1024

/** Streaming byte equality of two files (never loads either one whole). */
export async function sameFileBytes(aPath: string, bPath: string): Promise<boolean> {
  const sizes = await Promise.all([stat(aPath), stat(bPath)])
  if (sizes[0].size !== sizes[1].size) return false
  const [a, b] = await Promise.all([open(aPath, 'r'), open(bPath, 'r')])
  try {
    const aChunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
    const bChunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
    for (;;) {
      const [ra, rb] = await Promise.all([
        a.read(aChunk, 0, COMPARE_CHUNK_BYTES, null),
        b.read(bChunk, 0, COMPARE_CHUNK_BYTES, null),
      ])
      if (ra.bytesRead !== rb.bytesRead) return false
      if (ra.bytesRead === 0) return true
      if (!aChunk.subarray(0, ra.bytesRead).equals(bChunk.subarray(0, rb.bytesRead))) return false
    }
  } finally {
    await Promise.all([a.close(), b.close()])
  }
}

/** Streaming byte equality of a file against an in-memory buffer. */
export async function sameFileBuffer(path: string, bytes: Buffer): Promise<boolean> {
  const st = await stat(path)
  if (st.size !== bytes.length) return false
  const handle = await open(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
    let offset = 0
    for (;;) {
      const read = await handle.read(chunk, 0, Math.min(COMPARE_CHUNK_BYTES, bytes.length - offset), offset)
      if (read.bytesRead === 0) return offset === bytes.length
      if (!chunk.subarray(0, read.bytesRead).equals(bytes.subarray(offset, offset + read.bytesRead))) return false
      offset += read.bytesRead
    }
  } finally {
    await handle.close()
  }
}

/** True when the error means "the path does not exist". */
export function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Production probe: real byte comparisons via node:fs, links via lstat + nlink. */
export const defaultProbe: DiskProbe = {
  async matches(source: ByteSource | null, path: string): Promise<boolean | undefined> {
    try {
      if (source === null) {
        // A "created" record matches when the file is still absent.
        await stat(path)
        return false
      }
      if (source.kind === 'blob') return await sameFileBytes(path, source.path)
      if (source.kind === 'text') return await sameFileBuffer(path, source.bytes)
      // Legacy lossy string: compare with the same decode the v1 build used.
      return (await readFile(path)).toString('utf8') === source.text
    } catch (error) {
      // A missing file differs from any recorded content, but is exactly what a
      // `null` source records; anything else is an undecidable probe failure.
      if (isEnoent(error)) return source === null ? true : false
      return undefined
    }
  },
  async copy(path: string, dest: string): Promise<CopyOutcome> {
    try {
      // A FIFO or a device never reaches copyFile: opening one can block or
      // stream forever. A symlinked file is still copied through, because a
      // checkpoint of a dotfile a manager links into the tree is legitimate.
      const live = await lstat(path).catch(() => undefined)
      if (live !== undefined && !live.isFile() && !live.isSymbolicLink()) {
        return { kind: 'failed', message: `not a regular file: ${path}` }
      }
      await copyFile(path, dest)
      const st = await stat(dest)
      return { kind: 'copied', size: st.size }
    } catch (error) {
      if (isEnoent(error)) {
        // ENOENT covers two very different cases: the SOURCE is gone (nothing
        // to rescue — "absent") or `dest`'s parent directory does not exist (a
        // real failure). Only a missing source is "absent".
        const source = await stat(path).catch(() => undefined)
        if (source === undefined) return { kind: 'absent' }
      }
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  },
  async size(path: string): Promise<number | undefined> {
    try {
      const st = await stat(path)
      return st.isFile() ? st.size : undefined
    } catch {
      // Absent, unreadable or non-regular: an unknown size, never "too big".
      return undefined
    }
  },
  isUnsafeTarget: isUnsafeTarget,
}

/**
 * Atomic JSON file write: serialize to a sibling temp file, then rename over
 * the target. A crash between the two steps leaves only the temp — never a
 * readable half-written target — and rename is atomic, so readers always see
 * either the old file or the complete new one. The temp name is deterministic
 * (`<target>.tmp`): a crash-leftover temp is overwritten by the next write of
 * the same target and is never picked up by readers (it does not end in
 * `.json`). `afterTempWrite` is the test-only crash seam between the steps.
 */
export async function writeJsonAtomic(file: string, data: unknown, afterTempWrite?: () => void): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  afterTempWrite?.()
  await rename(tmp, file)
}

/** Recursive byte total of a directory tree (never follows symlinks). */
export async function dirBytes(dir: string): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    const full = join(dir, name)
    const st = await lstat(full).catch(() => undefined)
    if (st === undefined) continue
    if (st.isDirectory()) total += await dirBytes(full)
    else if (st.isFile()) total += st.size
  }
  return total
}

/**
 * True when the path is not a single regular file: a symlink, a hard link
 * (`nlink > 1`), a directory, a FIFO or a device. None is ever written,
 * created or read through on restore — a symlink redirects the operation, a
 * hard link clobbers every other name of the inode (e.g. pnpm-installed
 * files), and a FIFO or device either blocks the read or streams forever.
 * Mirrors Claude Code's "symlinked and hard-linked paths not restored", plus
 * the non-regular targets its restore guard also refuses.
 */
export async function isUnsafeTarget(path: string): Promise<boolean> {
  try {
    const st = await lstat(path)
    // A symlink is not a regular file under lstat, so the first test covers it.
    return !st.isFile() || st.nlink > 1
  } catch {
    return false
  }
}

/**
 * The nearest ancestor of `dir` (inclusive) that exists on disk, or undefined
 * when even the root is gone. Used to decide whether a MISSING parent chain can
 * be recreated safely (see {@link parentStillMatches}).
 */
async function nearestExistingAncestor(dir: string): Promise<string | undefined> {
  let current = dir
  for (;;) {
    const st = await lstat(current).catch(() => undefined)
    if (st !== undefined) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Where `path`'s directory resolved when the entry was captured — the location
 * pin. A directory that does not exist (or does not exist any more) pins where
 * it WOULD resolve: the `realpath` of its nearest surviving ancestor plus the
 * missing segments. A link created there later therefore cannot pass as the
 * same location, which is what makes an unpinned fallback unreachable for a
 * record this build writes. Undefined only when nothing at all resolves.
 */
export async function locationPin(path: string): Promise<string | undefined> {
  const dir = dirname(path)
  try {
    return await realpath(dir)
  } catch (error) {
    if (!isEnoent(error)) return undefined
  }
  const ancestor = await nearestExistingAncestor(dir)
  if (ancestor === undefined) return undefined
  try {
    return join(await realpath(ancestor), relative(ancestor, dir))
  } catch {
    return undefined
  }
}

/**
 * True when `path`'s parent directory still resolves where it did at checkpoint
 * time (`recorded`, the entry's location pin). Only the path's FINAL component
 * is checked for links and non-regular files (see {@link isUnsafeTarget});
 * without this a repointed ancestor
 * directory would redirect a restore — or, worse, an unlink — outside the
 * recorded location.
 *
 * - no pin (a legacy entry, or a commit that could not resolve its parent) →
 *   true: the released behavior is preserved;
 * - the parent resolves to the pinned location → true. A STABLE symlinked
 *   ancestor resolves identically on both sides (the pin is a `realpath`), so
 *   a symlinked workspace root is never a false skip;
 * - the parent resolves elsewhere → false;
 * - the parent chain is gone → true only while the nearest surviving ancestor
 *   still resolves INSIDE the pinned location, which keeps "recreate a deleted
 *   parent directory" working without following a repointed ancestor;
 * - anything undecidable (a link loop, an unreadable component) → false:
 *   refuse rather than write into a location that cannot be verified.
 */
export async function parentStillMatches(path: string, recorded: string | undefined): Promise<boolean> {
  if (recorded === undefined) return true
  const dir = dirname(path)
  try {
    return await realpath(dir) === recorded
  } catch (error) {
    if (!isEnoent(error)) return false
  }
  const ancestor = await nearestExistingAncestor(dir)
  if (ancestor === undefined) return false
  try {
    const real = await realpath(ancestor)
    // Only a real `..` SEGMENT escapes: a directory merely NAMED `..foo` is a
    // legitimate location inside the surviving ancestor.
    const inside = relative(real, recorded)
    const escapes = inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
    return inside !== '' && !escapes
  } catch {
    return false
  }
}

/**
 * Walk one directory tree and compute the total size (regular files only) and
 * the newest stamp (max `lstat.mtimeMs` over every member, directories
 * included). `lstat` never follows a symlink, so a hostile symlink inside the
 * store cannot escape the root or inflate the measurement; a symlink is
 * counted as one file's own metadata and not descended into. Directory members
 * beginning with `.` (atomic-write temp leftovers, editor droppings) are
 * skipped — they are never checkpoint entries.
 */
export async function dirSizeAndLastActive(dir: string): Promise<{ size: number; lastActiveMs: number }> {
  let size = 0
  let lastActiveMs = 0
  const visit = async (current: string): Promise<void> => {
    let st: Stats
    try {
      st = await lstat(current)
    } catch {
      return // already gone or unreadable: skip
    }
    if (st.mtimeMs > lastActiveMs) lastActiveMs = st.mtimeMs
    if (!st.isDirectory()) {
      size += st.size
      return
    }
    let names: string[]
    try {
      names = await readdir(current)
    } catch {
      return
    }
    for (const name of names) {
      // Dot-prefixed leftovers are never store members; `.pending/` is the
      // exception, and it must be visited so a staged capture counts as both
      // activity and bytes (otherwise a session whose only recent write is a
      // staged capture looks idle and is swept, and its size is under-reported).
      if (name.startsWith('.') && name !== PENDING_DIR) continue
      await visit(join(current, name))
    }
  }
  await visit(dir)
  return { size, lastActiveMs }
}
