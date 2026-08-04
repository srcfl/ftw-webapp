// @vitest-environment node

/* The relay and the carrier hold separate copies of their shared constants, so
 * that the server can be deployed and audited without the app beside it. This
 * is the guard that keeps the copies honest.
 */

import { describe, it, expect } from 'vitest'
import * as relay from './protocol.ts'
import { EPOCH_MS as RELAY_EPOCH_MS } from './epoch.ts'
import * as carrier from '$lib/carrier/relay'
import { EPOCH_MS, HANDLE_CHARS } from '$lib/carrier/rendezvous'

describe('the relay and the carrier agree on the wire', () => {
  it('uses the same close codes and control words', () => {
    expect(carrier.CLOSE_BAD_JOIN).toBe(relay.CLOSE_BAD_JOIN)
    expect(carrier.CLOSE_EPOCH).toBe(relay.CLOSE_EPOCH)
    expect(carrier.CLOSE_ROTATED).toBe(relay.CLOSE_ROTATED)
    expect(carrier.CLOSE_BUSY).toBe(relay.CLOSE_BUSY)
    expect(carrier.CTRL_READY).toBe(relay.CTRL_READY)
    expect(carrier.CTRL_GONE).toBe(relay.CTRL_GONE)
  })

  it('measures a handle the same way', () => {
    expect(HANDLE_CHARS).toBe(relay.HANDLE_CHARS)
  })

  it('runs the same epoch length', () => {
    // Disagreement here costs a round trip rather than correctness — the relay
    // corrects a wrong guess — but a round trip on every connect is a real
    // cost, so it is worth failing the build over.
    expect(EPOCH_MS).toBe(RELAY_EPOCH_MS)
  })
})
