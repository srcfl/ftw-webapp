/* Protocol types.
 *
 * Names shared with the box come from contract/registry.yaml and will be
 * generated into src/lib/contract/generated.ts. These are the structural
 * types around them — shapes, not names.
 *
 * See docs/protocol.md.
 */

/** How frames are reaching us. Orthogonal to SourceState — see FreshnessBand. */
export type CarrierState = 'webrtc' | 'relay' | 'cache' | 'none'

/** Whether a box-side source is answering. Orthogonal to CarrierState. */
export type SourceState = 'live' | 'lagging' | 'stale' | 'down' | 'never'

/** Field id. 1–9 are frozen permanently; see contract/registry.yaml. */
export type Fid = number

export interface Source {
  kind: string
  name: string
  /** Box uptime when this source last answered. Not wall clock. */
  lastOkMs: number
  staleAfterMs: number
  state: SourceState
}

/**
 * The box's clock, reported at handshake.
 *
 * A Pi has no RTC: after a power cut its wall clock reads 1970 until NTP
 * answers, which would make every age wrong by decades. All ages are
 * computed as deltas against `uptimeMs`, never against wall time.
 */
export interface BoxClock {
  source: 'ntp' | 'rtc' | 'none'
  /**
   * Null when the box has never synced.
   *
   * Not zero: 0 is a real 1970 timestamp, and a box that has just lost power
   * is exactly the case this field exists to describe. Go sends 0 for
   * "never", so anything reading this must treat 0 as null — noted rather
   * than silently normalised, because the wire is the box's to change.
   */
  syncedAtMs: number | null
  uptimeMs: number
}

export interface Snapshot {
  /** Box uptime at which this snapshot was taken. */
  uptimeMs: number
  /** Monotonic per site, bumped by every mutation of controllable state. */
  controlRev: number
  fields: Map<Fid, number>
  sources: Map<string, Source>
  /** Source ids currently preventing dispatch, per the box's safety rules. */
  dispatchBlockedBy: string[]
}

export interface Delta {
  seq: number
  uptimeMs: number
  fields: Map<Fid, number>
  /** Present only when a source changed state — usually absent. */
  sources?: Map<string, Source>
  /** Set when the delta could not fit its bucket; the rest follows. */
  truncated: boolean
}

export interface ProtocolError {
  code: string
  retryable: boolean
  retryAfterMs?: number
  args?: Record<string, unknown>
}
