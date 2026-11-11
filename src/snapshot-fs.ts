/**
 * Filesystem primitives for the checkpoint store.
 *
 * Every operation that can touch the real filesystem lives here: atomic JSON
 * writes (temp + rename), streaming byte comparisons (never a whole file in
 * memory), the location pin that keeps a restore inside the directory it
 * recorded, and the rejection of links and non-regular targets. Nothing here
 * holds state; the store passes in what it needs.
 *
 * @module dsh-rewind/snapshot-fs
 */

import type { Stats } from 'node:fs'
import { lstat, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

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

/** True when the error means "the path does not exist". */
export function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/**
 * Atomic JSON write: serialize to a sibling temp file, then rename over the
 * target. A crash between the two steps leaves only an inert temp — never a
 * readable half-written target — and rename is atomic, so readers always see
 * the old file or the complete new one. The temp name is deterministic
 * (`<target>.tmp`): a crash leftover is overwritten by the next write and is
 * never picked up by readers. `afterTempWrite` is a test-only seam between the
 * steps.
 */
export async function writeJsonAtomic(file: string, data: unknown, afterTempWrite?: () => void): Promise<void> {
  const tmp = `${file}.tmp`
  // A crash leftover is inert; EXCL also refuses a symlink planted at the temp
  // name instead of following it.
  await rm(tmp, { force: true }).catch(() => undefined)
  await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' })
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
    // Atomic-write leftovers are never store members.
    if (name.endsWith('.tmp')) continue
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
 */
export async function isUnsafeTarget(path: string): Promise<boolean> {
  try {
    const st = await lstat(path)
    // A symlink is not a regular file under lstat, so the first test covers it.
    return !st.isFile() || st.nlink > 1
  } catch (error) {
    // An absent final component is safe to create; an undecidable probe is not.
    return !isEnoent(error)
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
 * Where `path`'s directory resolved when the row was captured — the location
 * pin. A directory that does not exist (or does not exist any more) pins where
 * it WOULD resolve: the `realpath` of its nearest surviving ancestor plus the
 * missing segments. A link created there later therefore cannot pass as the
 * same location. Undefined only when nothing at all resolves.
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
 * True when `path`'s parent directory still resolves where it did at capture
 * time (`recorded`, the location pin). Only the path's FINAL component is
 * checked for links and non-regular files (see {@link isUnsafeTarget});
 * without this a repointed ancestor directory would redirect a restore — or,
 * worse, an unlink — outside the recorded location.
 *
 * `undefined` means "no pin": this build never writes such a row, so the
 * caller must treat it as untrusted and skip the path.
 *
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
  if (recorded === undefined) return false
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
 * counted as one file's own metadata and not descended into. Atomic-write
 * temp leftovers are skipped; every other member (including legacy snapshot
 * members) counts toward the session's footprint and activity.
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
      if (name.endsWith('.tmp')) continue
      await visit(join(current, name))
    }
  }
  await visit(dir)
  return { size, lastActiveMs }
}
