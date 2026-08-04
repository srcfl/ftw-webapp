import { describe, it, expect } from 'vitest'
import { EPOCH_MS, HANDLE_CHARS, currentEpoch, rendezvousHandle } from './rendezvous'

const SECRET = new Uint8Array(32).fill(1)

describe('rendezvous handles', () => {
  it('is hex of a fixed width', () => {
    const handle = rendezvousHandle(SECRET, 42)
    expect(handle).toHaveLength(HANDLE_CHARS)
    expect(handle).toMatch(/^[0-9a-f]+$/)
  })

  it('is the same for both ends of the same epoch', () => {
    expect(rendezvousHandle(SECRET, 42)).toBe(rendezvousHandle(SECRET, 42))
  })

  it('shares nothing between epochs', () => {
    const a = rendezvousHandle(SECRET, 42)
    const b = rendezvousHandle(SECRET, 43)
    expect(a).not.toBe(b)

    // Not a counter, not a prefix, not a rotation of itself: HKDF-Expand is a
    // PRF, so an observer without the secret sees two unrelated strings and
    // has no function that takes it from one to the other.
    let shared = 0
    for (let i = 0; i < HANDLE_CHARS; i++) if (a[i] === b[i]) shared += 1
    expect(shared).toBeLessThan(HANDLE_CHARS / 2)
  })

  it('separates households', () => {
    const other = new Uint8Array(32).fill(2)
    expect(rendezvousHandle(SECRET, 42)).not.toBe(rendezvousHandle(other, 42))
  })

  it('refuses a secret too short to be one', () => {
    expect(() => rendezvousHandle(new Uint8Array(8), 42)).toThrow()
  })
})

describe('the epoch guess', () => {
  it('steps once per epoch length', () => {
    expect(currentEpoch(0)).toBe(0)
    expect(currentEpoch(EPOCH_MS - 1)).toBe(0)
    expect(currentEpoch(EPOCH_MS)).toBe(1)
  })

  it('reads zero on a box whose clock never started', () => {
    // A Pi with no RTC after a power cut. The relay corrects it on the first
    // connect, which costs a round trip and nothing else.
    expect(currentEpoch(0)).toBe(0)
  })
})
