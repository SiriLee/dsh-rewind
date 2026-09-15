/**
 * `image/offload` is the alpha line's first `SessionMessageProjection`: it
 * changes derived message CONTENT without touching surface node membership, and
 * a replay that lacks its projection definition throws. The plugin never
 * rebuilds sessions in production (it reads the live `session.surface.nodes`),
 * so these probes pin the boundary: the plugin's candidate listing and target
 * resolution tolerate a log carrying `image/offload`, and only reconstruction
 * needs the definition.
 */
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import { foldSurface, Session, SessionId } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { listRewindCandidates, planRewind } from '../src/rewind.ts'

const image: ImageBlock = {
  type: 'image',
  attachment: {
    attachmentId: `sha256:${'a'.repeat(64)}` as never,
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  },
}

/** A session whose creation carries the projection definition (the live shape). */
function createSession(id: string): Session {
  return Session.create(SessionId(id), undefined, undefined, undefined, [imageOffloadProjection])
}

/** Append one human user message with an image and a text block. */
function appendImageQuestion(session: Session) {
  const content: ContentBlock[] = [image, { type: 'text', text: 'what is this?' }]
  return session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' })
}

describe('image/offload message projection', () => {
  it('changes derived content without changing surface node membership', () => {
    const session = createSession('image-offload-live')
    const source = appendImageQuestion(session)
    const before = [...session.surface.nodes]
    session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [0] }] })
    expect([...session.surface.nodes]).toEqual(before)
    const [message] = session.deriveMessages()
    const first = message?.content[0]
    expect(first?.type).toBe('image')
    expect(first?.type === 'image' && first.offloaded).toBe(true)
  })

  it('throws on replay without the projection and reconstructs with it', () => {
    const session = createSession('image-offload-replay')
    const source = appendImageQuestion(session)
    session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [0] }] })
    const events = session.snapshotEvents()
    expect(() => foldSurface(events)).toThrow()
    expect(() => Session.create(SessionId('image-offload-noproj'), events)).toThrow()
    const folded = foldSurface(events, [imageOffloadProjection])
    expect([...folded.nodes]).toEqual([...session.surface.nodes])
    const rebuilt = Session.create(SessionId('image-offload-rebuilt'), events, undefined, undefined, [imageOffloadProjection])
    expect([...rebuilt.surface.nodes]).toEqual([...session.surface.nodes])
  })

  it('leaves the plugin candidate listing and target resolution unchanged', () => {
    const session = createSession('image-offload-candidates')
    const source = appendImageQuestion(session)
    const surface = [...session.surface.nodes]
    const before = listRewindCandidates(session.snapshotEvents(), surface).map(candidate => candidate.seq)
    session.append('image/offload', { targets: [{ seq: source.seq, imageIndexes: [0] }] })
    const events = session.snapshotEvents()
    const surfaceAfter = [...session.surface.nodes]
    expect(listRewindCandidates(events, surfaceAfter).map(candidate => candidate.seq)).toEqual(before)
    const plan = planRewind(events, surfaceAfter, { kind: 'seq', seq: source.seq })
    expect(plan.targetSeq).toBe(source.seq)
    expect(plan.shadowedSeqs).toEqual([source.seq])
  })
})
