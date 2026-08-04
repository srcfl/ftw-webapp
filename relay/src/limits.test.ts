// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { AttemptCounter, TokenBucket } from './limits.ts'

describe('token bucket', () => {
  it('spends its capacity and then refuses', () => {
    const bucket = new TokenBucket(3, 1, 0)
    expect(bucket.take(1, 0)).toBe(true)
    expect(bucket.take(1, 0)).toBe(true)
    expect(bucket.take(1, 0)).toBe(true)
    expect(bucket.take(1, 0)).toBe(false)
  })

  it('refills with time and never past its capacity', () => {
    const bucket = new TokenBucket(3, 10, 0)
    expect(bucket.take(3, 0)).toBe(true)
    expect(bucket.take(1, 50)).toBe(false)
    expect(bucket.take(1, 100)).toBe(true)

    // An idle hour does not buy an hour's worth of burst.
    expect(bucket.take(3, 3_600_000)).toBe(true)
    expect(bucket.take(1, 3_600_000)).toBe(false)
  })
})

describe('attempt counter', () => {
  it('limits a caller within the window', () => {
    const counter = new AttemptCounter({ limit: 3, windowMs: 1000 }, 0)
    expect(counter.allow('10.0.0.1', 0)).toBe(true)
    expect(counter.allow('10.0.0.1', 0)).toBe(true)
    expect(counter.allow('10.0.0.1', 0)).toBe(true)
    expect(counter.allow('10.0.0.1', 0)).toBe(false)
  })

  it('forgets everything when the window turns', () => {
    const counter = new AttemptCounter({ limit: 1, windowMs: 1000 }, 0)
    expect(counter.allow('10.0.0.1', 0)).toBe(true)
    expect(counter.allow('10.0.0.1', 500)).toBe(false)
    expect(counter.allow('10.0.0.1', 1000)).toBe(true)
  })

  it('keeps callers mostly apart without keeping a list of them', () => {
    // With 1024 slots and a keyed hash, distinct callers land apart nearly
    // always. "Nearly" is the deliberate trade: the structure cannot be turned
    // back into a list of who was here, and the price is that a few unlucky
    // neighbours share a limit.
    const counter = new AttemptCounter({ limit: 1, windowMs: 1000 }, 0)
    let allowed = 0
    for (let i = 0; i < 100; i++) {
      if (counter.allow(`10.0.0.${i}`, 0)) allowed += 1
    }
    // Around five of the hundred collide. The key is fresh every run, so the
    // bound is loose enough that an unlucky draw is not a failing build.
    expect(allowed).toBeGreaterThan(85)
  })
})
