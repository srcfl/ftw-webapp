# Wire protocol

The contract between this app and an FTW box. It runs inside a Noise IK
session, which runs inside whichever carrier is active.

Names shared with the box — scopes, capabilities, error codes, field ids —
come from [`contract/registry.yaml`](../contract/registry.yaml). It generates
TypeScript here and Go constants in the box, and CI fails when they drift.
Never hand-write one of those names in either language.

## Frames

Each Noise transport message carries exactly one frame.

```
offset  field    type     note
0       ver      u8       frame layout version
1       lane     u8       0 = telemetry/control, 1 = bulk
2       flags    u8       0x02 TRUNC
3       rsvd     u8       0
4       len      u16 BE   payload bytes
6       payload  u8[len]  CBOR
6+len   pad      u8[]     zeros to the bucket size
```

The receiver ignores everything past `len`. Padding is never validated — AEAD
already covers it.

**Lane 0** carries `tick`, `delta`, `cmd`, `cmd.ack`, `cmd.result` and
`event`. It is exactly one bucket, always, and never fragments. Cadence and
size are fixed for the life of the session: 512 B at 1 Hz in the foreground,
512 B at 0.2 Hz when the document is hidden. If the box has nothing to say it
sends `tick` anyway.

This constancy is a privacy control, not a performance choice. A delta that
does not fit sends the highest-priority fields and sets `TRUNC`; the rest
follows on the next tick or as a fresh snapshot on the bulk lane. It never
grows the bucket and never fragments, because both would make frame size a
function of what happened in the house.

**Lane 1** carries snapshots and history chunks. Buckets step 1024 / 4096 /
16384. Bulk leaks that a transfer is happening, which is unavoidable and
harmless — what must not leak is the 1 Hz stream, and that lives on lane 0.

## Envelope

```ts
type Envelope = {
  t: string       // message type, stable string
  id?: number     // request id, u32; replies echo it
  b?: unknown     // body
}
```

CBOR, deterministic encoding, text keys.

**Unknown map keys and unknown message types are ignored silently, in both
directions.** This is the rule that lets a newer app talk to an older box and
the reverse. A service worker can pin a bundle for a long time; a hard version
wall would turn that into a white screen. Both sides have a test that feeds in
junk keys.

## Messages

Fifteen types in v1.

| Type | Direction | Purpose |
|---|---|---|
| `hello` / `hello_ok` | C→B / B→C | Version range, capabilities, clock, boot state |
| `sub` | C→B | Start the telemetry stream |
| `snap` | B→C | Full site snapshot with the field dictionary |
| `delta` | B→C | Changed fields by id |
| `tick` | B→C | Nothing changed; keeps the cadence constant |
| `hist.query` / `hist.chunk` / `hist.end` | | Time window and resolution |
| `cmd` / `cmd.ack` / `cmd.result` | | Intent, receipt, and observed outcome |
| `event` | B→C | Something worth surfacing happened |
| `error` | B→C | Stable code with machine-readable args |
| `session.terminate` | B→C | Access revoked or session ended |

## Versioning

The client sends `proto: {min, max}`; the box picks `min(box.max, client.max)`.
If the client is too old the box does **not** error — it replies
`hello_ok{proto: 0, mode: "floor", hint: "app_update"}` and the app degrades
to the frozen subset instead of dying.

Capabilities are a set of names, not version comparisons. The UI gates on
presence; absent means hide, never crash.

Field ids 1–9 are frozen permanently as of v1: mode, grid power, PV power,
battery power, battery state of charge, load power, and their source ids. Any
app, however old, can draw the core view. Freezing them now is free; doing it
later is not.

## Freshness

Every reading points at a **source**, not at its own timestamp:

```ts
sources: {
  [srcId]: {
    kind: string
    name: string
    lastOkMs: number
    staleAfterMs: number
    state: 'live' | 'lagging' | 'stale' | 'down' | 'never'
  }
}
```

The app materialises per-field freshness by looking up `fid → src → sources`.
That keeps deltas at tens of bytes while still answering the question users
actually have: the box is fine, but the inverter went quiet 40 seconds ago.

Ages are computed against the box's **uptime**, not its wall clock. A Pi has
no RTC: after a power cut its clock reads 1970 until NTP answers, which would
make every age wrong by decades. `hello_ok` carries
`{source, syncedAtMs, uptimeMs}` and all ages are uptime deltas.

`dispatchBlockedBy: [srcId]` connects directly to the box's safety invariant
that stale meter data stops dispatch — so the app can say why nothing is
happening instead of looking broken.

## History

Two resolutions in v1: `5m` from the energy ledger (30 days) and `1h` from the
hourly rollup (2 years, the box's only versioned storage contract).

**Downsampling always happens on the box.** One reading per second for a year
is 31 million points; that number never crosses the wire. If a window exceeds
`maxPoints` the box clamps to a coarser resolution and reports `resActual`. It
never fails with "too much data".

Transfer is tile-based — a 5m tile covers 12 hours, a 1h tile covers 7 days —
with an etag per tile. The client sends `have: [{tileId, etag}]` and receives
only the difference. Closed tiles are immutable; the trailing tile is marked
partial and never cached.

Chunks are column-packed int32 little-endian inside CBOR byte strings, so the
client gets an `Int32Array` without parsing. `INT32_MIN` marks a missing
sample — distinct from zero, which is a real reading.

## Commands

Intent and execution are separate, and the gap between them is where safety
lives.

```ts
{
  t: 'cmd',
  b: {
    cmdId: string          // UUIDv7, idempotency key, kept 24 h on the box
    op: string
    args: Record<string, unknown>
    notValidAfterMs: number // mandatory
    expect: { rev: number, guards: Guard[] }
  }
}
```

`notValidAfterMs` is mandatory because a command queued offline must never
execute blindly later. "Charge the battery at 10 kW" arriving three hours late
is rejected with `E_CMD_EXPIRED` — and even inside its window, `guards` are
re-evaluated against fresh state at the dispatch boundary, so it is rejected
with `E_PRECONDITION` if the state of charge has since passed the limit.

`expect.rev` is one global `controlRev` per site, monotonic, bumped by every
mutation of controllable state.

Three separate clocks, three different events — not three versions of one:

| Elapsed | Meaning |
|---|---|
| 1 200 ms | Show "sending…" |
| 5 000 ms without `cmd.ack` | Transport failure: "didn't reach the box" |
| 15 000 ms without `cmd.result` | `unconfirmed` — the box accepted it, the hardware has not confirmed |

`cmd.ack` means the dispatcher accepted the intent and returns a lease with an
absolute expiry. `cmd.result` arrives separately, when the driver has **read
the value back**, carrying `observed: {value, src, tsMs}`. The echo of the
requested value is never sent as confirmation — that is the difference between
knowing a command was heard and knowing it happened.

## Errors

Stable `E_`-prefixed codes with `retryable`, `retryAfterMs` and machine-
readable `args`. The box sends codes; this app owns all prose, in every
language. The single exception is push payloads, which must carry rendered
text — those templates are generated from this app's catalogue in CI and
shipped with the firmware.
