/**
 * Unit tests for the message image helpers in `src/client/hidden.ts`.
 */
import { describe, expect, it } from 'vitest'
import { imageRefsOf } from '../src/client/hidden.ts'

describe('imageRefsOf', () => {
  it('keeps the complete durable reference the session image read verifies', () => {
    expect(imageRefsOf([{
      type: 'image',
      attachment: { attachmentId: 'a6', mediaType: 'image/webp', bytes: 42, width: 7, height: 9, name: 'shot.webp' },
    }])).toEqual([{
      attachmentId: 'a6', mediaType: 'image/webp', bytes: 42, width: 7, height: 9, name: 'shot.webp',
    }])
  })

  it('skips malformed, non-image and file blocks', () => {
    expect(imageRefsOf([
      { type: 'text' },
      { type: 'file', attachment: { attachmentId: 'f1', mediaType: 'text/plain' } },
      { type: 'image', attachment: { attachmentId: 'bad' } },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
    ])).toEqual([{ attachmentId: 'a1', mediaType: 'image/png' }])
  })

  it('returns [] for missing content', () => {
    expect(imageRefsOf(undefined)).toEqual([])
  })
})
