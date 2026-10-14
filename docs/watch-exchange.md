# Watch exchange: commands from an Apple Watch without the phone

- Status: proposed 2026-10-14. Nothing here has shipped.
- Pair: [srcfl/ftw ADR 0009](https://github.com/srcfl/ftw/blob/master/docs/adr/0009-watch-exchange.md)
  holds Core's side. Neither works without the other.
- Fredrik decided on 14 October 2026 that a watch controls the box directly
  as well as through the phone, that an unlocked watch on the wrist counts as
  unlocked, and that each watch has its own key, which the owner can remove
  alone. The rest is a recommendation until he answers the open decisions in
  ADR 0009.

## The problem

watchOS gives an ordinary app HTTPS through `URLSession` and nothing lower.
`URLSessionWebSocketTask` and Network.framework work only for audio
streaming, CallKit calls and DeviceDiscoveryUI
([TN3135](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos)).
The relay speaks only WebSocket, so a watch cannot reach a box on its own. The
W1 watch app hands its intent to the phone, which opens the session. That
fails when the phone is away, flat or off.

The direct path needs a request and an answer over HTTPS that keep every
promise the stream keeps: the relay stays blind, the box decides, a late
command never runs, and no length says anything about the house.

## Shape

```
watch ──HTTPS POST /x/<epoch>/<handle>──▶ ┌───────┐ ──ws: id ‖ body──▶ box
      ◀──────── 200, reply ──────────────  │ relay │ ◀──ws: id ‖ reply──
                                           └───────┘
```

- **The box opens a second socket,** `/r/<epoch>/<handle>/exchange`, beside
  its uplink. Same handle, same epoch, same rotation. A box that does not open
  it lacks this feature and nothing else changes for it.
- **The watch posts one Noise message** to
  `https://relay.ftw.energy/x/<epoch>/<handle>`. It derives the handle from
  the same rendezvous secret the phone holds.
- **The relay draws a random 16-byte id,** sends `id ‖ body` on the exchange
  socket, waits for `id ‖ reply` and returns the reply as the answer body. It
  reads the id it wrote and nothing else. It drops a reply whose id it is not
  waiting for.
- **Room traffic and exchanges never meet.** No stream sees an exchange, and
  the exchange socket sees no stream frame. An exchange never takes one of the
  four stream places, so a watch cannot push a phone out.
- **Rotation.** For the five minutes the relay spreads a rotation over, it also
  accepts the previous epoch on `/x/`. A watch that meets 404 in that window
  tries the previous epoch's handle once.

The relay answers in its own words:

| Status | Meaning |
|---|---|
| 200 | The box replied; the body is its reply, unchanged |
| 400 | The body has a size or type the route does not take |
| 404 | No box on this handle now |
| 409 | Wrong epoch; the body carries the right one |
| 429 | Rate limited |
| 501 | A box is here but opened no exchange socket: it needs an update |
| 504 | The box did not reply within 10 s |

## Exchanges

Every frame is a lane 0 frame, one 512 B bucket, as on the stream
([protocol.md, Frames](protocol.md#frames)). So every body at a given step
has one length, whatever the op, its args or the outcome.

| Step | Watch sends | Box answers | Bytes up / down |
|---|---|---|---|
| X1 open | IK message 1. Payload: `hello`, with the pairing code on the first run only | IK message 2. Payload: `hello_ok` cut to lane 0: role, scopes, clock, `rev` | 608 / 560 |
| X2 command | `cmd` | `cmd.ack`, then `cmd.result`, or `tick` in its place if the result has not settled within 3 s | 536 / 1 072 |
| X3 ask again | The same `cmd`, same `cmdId` | As X2, from the box's command log | 536 / 1 072 |

Message 1 is 32 bytes of ephemeral key, 48 of sealed static key and 528 of
sealed frame. Message 2 is 32 bytes of ephemeral key and 528 of sealed frame.
A transport message is 8 bytes of sequence, 512 of frame and a 16-byte tag.

## Noise: IK, one round trip, opened early

**IK, as on the stream.** The same pattern and code in Go, TypeScript, Swift
and Kotlin, checked against the same vectors. The prologue is
`ftw.exchange.v1:` and the box's static key, so a stream handshake and an
exchange handshake can never stand in for each other. The watch gets the box's
static key from the phone. IK seals the watch's own static key under `es`, so
the relay never sees which device asks.

**Not KK.** KK would save those 48 bytes, but then the box must know the
caller before it can read message 1. That needs a key id in the clear, and the
id would name one watch to the relay across every epoch. The rotating handle
exists to prevent exactly that.

**Not 0-RTT.** IK lets message 1 carry the command and save a round trip. But
message 1 is sealed to static keys only: the box has added no fresh
randomness, so anyone who records it can replay it until the command expires.
And `notValidAfterMs` counts in box uptime, which the watch learns only from
`hello_ok`. A 0-RTT command would need a replay cache that survives a reboot
and a clock the watch cannot read. The round trip costs less.

**Opened early.** The watch runs X1 when the confirm screen appears, not when
the person confirms. People read the screen for longer than a round trip
takes, so the tap waits for X2 alone.

**Short sessions.** A session ends after four exchanges, 60 s without one, or
3 minutes, whichever comes first. The watch keeps it in memory and drops it
when the app leaves the screen.

**Replay.** A replayed message 1 draws a fresh message 2 under a new box
ephemeral key, which only the real watch can use. A replayed transport message
fails the session's replay window (`appwire/transport.go` in Core). A replayed
command in a fresh session meets the command log and gets the stored outcome,
not a second action. A late one meets `notValidAfterMs`.

**The deadline belongs to the watch.** It is 30 s after the tap, kept on the
watch's own clock and turned into box uptime from each `hello_ok`. A retry
after the box restarts cannot outlive the tap.

## The receipt line

The stream sends `cmd.ack` and `cmd.result` as two frames, and Core settles
the result in the same pass that takes the intent: within 2 s for a charger,
which is the wait for the EV save. So one answer can carry both. The box holds
the X2 answer until the result settles or 3 s pass. The watch never shows the
requested value as fact; it shows `observed`.

| What the watch has | What it says |
|---|---|
| Nothing yet, 1.2 s in | Sending… |
| `cmd.ack` and `cmd.result: applied` | Done, with the observed value and its age |
| `cmd.ack` and `cmd.result: unconfirmed` | The box took it; the charger has not confirmed |
| `cmd.ack` and `tick` | The box took it; waiting for the charger. Then X3 |
| `cmd.result: rejected` | The app's sentence for the code |
| 404, no network, or no answer in 12 s | Did not reach the box. A retry is safe: same `cmdId` |
| 501 | The box needs an update for this. The phone path still works |

A retry with the same `cmdId`, from the watch or from the phone that added it,
returns what happened the first time. That needs Core's command log to outlive
a session, which it does not today ([ADR 0009](https://github.com/srcfl/ftw/blob/master/docs/adr/0009-watch-exchange.md),
decision 3).

The carrier the watch names is `relay`, which the registry already has.

## Adding a watch

1. The watch app asks the phone over WatchConnectivity.
2. The phone shows one sheet: let this watch control the house without the
   phone. The owner confirms with the passkey (step-up).
3. The phone asks for a watch code over its session:
   `POST /api/app-link/pairing` with role `watch`. Only an owner may, and only
   over a session. The box binds the code to that phone.
4. The phone sends the box's static key, the rendezvous secret, the code and
   the relay URL with `transferUserInfo`. None of it passes through a
   Sourceful service.
5. The watch makes its own Curve25519 key and runs X1 with the code. The
   private key never leaves the watch.
6. The box stores the watch with role `watch` and the phone as its parent.

**Role `watch`.** Scopes `ftw.live.read` and `ftw.dispatch.write`: Charge
now, Pause, Back to the plan and the car's level. Not `ftw.mode.write`, no
members scopes, no passthrough, no history. Each check takes the role's scopes
and keeps only those the parent phone holds at that moment, so a watch can
never do more than its phone can now.

**Unlocked means on the wrist.** The watch keeps its key under
`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`. The key works only while
the watch is unlocked, which with wrist detection on means on the wrist, and
the watch erases it if someone removes the passcode. Fredrik's decision
becomes a property of the key, not a check in the app. The Secure Enclave
has no Curve25519 keys, so this key cannot live there.

**Removal.** The box lists each watch under its phone. Removing a watch ends
that watch alone. Removing a phone ends its watches too. A removed key gets
what a stranger's key gets: no reply from the box, as on the uplink, and 504
from the relay.

## What the relay must never learn

- What the command is, what it asks or what happened.
- Which device asks. IK seals the static key, and the device list lives only
  on the box.
- The pairing code. It travels inside message 1's sealed payload.
- Anything after the answer. Open exchanges sit in a map in memory, keyed by
  the relay's own random id, and leave it when the answer goes or the timer
  fires. No log line names a handle, an address, a size or a time.

**What it still knows,** listed the way
[relay/README.md](../relay/README.md#what-it-still-knows) lists it for the
stream:

- That someone with this hour's handle sent a request at a given time from a
  given address.
  [architecture.md](architecture.md#what-is-not-yet-true) names the same
  channel for app-to-box frames, which leave only on a person's action.
- Which step a request is, from its size. The order already told it that.
- How long the box took. A refusal answers in milliseconds; an applied command
  waits for the EV save. Test 6 measures whether that gap shows through network
  jitter. If it does, the box answers no sooner than a fixed floor, and that
  floor is open decision F in ADR 0009.
- That this handle had an HTTPS client this hour.

**The proxy log.** With the URI and addresses cut, Caddy's access log still
keeps one line per request with sizes and a duration. On `/x/` that is one
line per command with its time: the record the escrow had to remove from its
proxy. Caddy skips the access log for `/x/` altogether.

This covers the relay. FTW Cloud is a separate service that reads what an
owner turns on ([ADR 0008](https://github.com/srcfl/ftw/blob/master/docs/adr/0008-ftw-cloud.md));
the exchange never touches it, and it still never controls.

## Limits and abuse

The relay's limits keep no list, as `relay/src/limits.ts` already does.

- Per address: its own `AttemptCounter`, 30 requests a minute.
- Per room: at most 2 open exchanges and 30 a minute, on a counter that lives
  on the room and dies with it.
- Per process: at most 1 024 open exchanges; past that, 429.
- Bodies: exactly 608 or 536 bytes in, at most 2 KiB back from the box.
  Anything else ends the request with 400 or closes the exchange socket with
  4400.
- Each exchange waits 10 s at most.
- The route takes only `content-type: application/octet-stream` and sends no
  CORS headers, so a web page cannot post to it.

The box ([ADR 0009](https://github.com/srcfl/ftw/blob/master/docs/adr/0009-watch-exchange.md)):

- At most 8 exchange sessions, outside the four stream places.
- At most 60 opening messages a minute; it drops the rest unanswered. Each
  costs up to four X25519 operations.
- An exchange session takes `cmd` and nothing else.

The watch never polls. It asks once more with X3 when the result has not
settled, and retries only when the person taps again.

## Latency and battery

Not measured. These are the bars the device tests must meet.

- The path: watch, then the phone over Bluetooth, known Wi-Fi or the watch's
  own LTE, then relay, box and back.
- TLS costs two round trips and X1 one more. Both happen while the confirm
  screen shows.
- The tap then waits for one round trip from watch to relay, one hop from
  relay to box and Core's own time.
- Bar: p95 from tap to receipt under 2 s through the phone or Wi-Fi and under
  3 s on LTE, 20 runs each.
- Battery: no socket stays open, nothing runs in the background, and a command
  moves under 4 KB. Waking the LTE radio costs the most. The device test reads
  Xcode's energy gauge for one command beside one complication refresh.
- `ProcessInfo.performExpiringActivity` wraps each command, so lowering the
  wrist does not cut it off. If watchOS ends it anyway, the next open asks
  again with the same `cmdId`.
- One ephemeral `URLSession` per command, invalidated after it. No connection
  lives across the hour, so the watch gives the relay no link between two
  handles beyond what addresses and timing already give.

## What changes where

**Relay (this repo).** A third join role, `exchange`, box side only, one per
room; the first holds it, as with the uplink. The `/x/<epoch>/<handle>` route,
the map of open exchanges and the limits above. `relay/README.md` gains one
claim: on the exchange socket the relay reads the 16-byte id it wrote and
nothing else. `inspect()` adds a count of open exchanges. The Caddyfile skips
the access log on `/x/`.

**Registry (this repo, copied to Core and ftw-app).** Role `watch` with the two
scopes. Capability `cmd.exchange`, which tells the phone the box can take a
watch. No new error codes.

**Web app.** Nothing. It never uses the exchange.

**Core.** [ADR 0009](https://github.com/srcfl/ftw/blob/master/docs/adr/0009-watch-exchange.md):
the exchange socket, exchange sessions, a box-wide command log, the watch
role, its parent and removal by parent.

**iPhone app (srcfl/ftw-app).**

- Offers "Add watch" only with `cmd.exchange` and the owner role.
- The sheet with step-up, then the code and keys to the watch.
- The watch under its phone in the device list, with Remove.
- The W1 phone path stays as the fallback. It uses the `cmdId` the watch
  minted, so a command that tried both paths runs once.

**Watch app.**

- Noise, transport, frames, CBOR and the rendezvous code build for watchOS.
  They import Foundation and CryptoKit only. The WebSocket carrier stays on
  iOS.
- An exchange carrier: X1 when the confirm screen appears, X2 on confirm, X3
  when the result has not settled.
- `CommandPath`: direct when the watch has its own key and the box has
  `cmd.exchange`; through the phone when the direct path fails before it
  reaches the box (no network, 404, 501). After a timeout with no answer, a
  retry may take either path with the same `cmdId`.
- The watch mints `cmdId`. In the W1 plan the phone builds the whole `cmd`;
  W1 should let the watch mint the id and pass it along, so a command that
  tried both paths runs once.

## Alternatives

| Alternative | Why it is worse |
|---|---|
| The box polls a mailbox on the relay | The box already holds a socket. A mailbox stores ciphertext on a relay that today stores no routed traffic. The poll interval adds delay, and the watch must poll for the result too |
| Push to the box through FTW Cloud | FTW Cloud reads and never controls (ADR 0008). Even sealed end to end, it would become a control path that must stay up |
| A header on every uplink frame instead of a second socket | Saves a socket, but every frame of every house gets a header the relay must parse, and its claim to read only `.length` ends for all traffic |
| The command in message 1 (0-RTT) | Replayable until it expires, and the watch does not yet know the box's uptime |
| KK | A key id in the clear names the watch to the relay |
| One answer that streams `cmd.ack`, then `cmd.result` | Needs the proxy to flush mid-body and keeps the radio awake. Core settles both in one pass, so one answer is enough |
| Commands only through the phone (W1) | Fails when the phone is away, which is why Fredrik asked for this |
| HTTPS from the watch to the box on the LAN, certificate pinned | Works without internet, but adds a TLS listener and a certificate to the box, and the watch picks its own network. Helps only at home, where the phone usually is |

## Tests that prove it

Relay:

1. `relay-blindness` gains exchanges: a box and a watch client across a real
   relay. It searches every routed byte, log line and `inspect()` for message
   types, op names, device names and watt readings, after showing that the
   search catches them unsealed.
2. Routing: a reply reaches only its own request; no stream sees an exchange;
   the exchange socket sees no stream frame; a reply with an unknown id goes
   nowhere.
3. Shape: every body at a step has one length for every op and outcome; any
   other size gets 400.
4. Limits: the per-address counter, two open per room, the process cap and the
   10 s timeout, each reached and shown to refuse.
5. Epoch: 409 carries the right epoch; rotation closes the exchange socket with
   its room; the previous epoch works on `/x/` during the spread and not after.

Core (ADR 0009):

6. Timing: time to answer for applied and refused commands, at the box and
   through the relay. The result settles open decision F.
7. Replay: a recorded message 1 draws a message 2 that a replayer cannot use;
   a recorded X2 fails in its own session; in a fresh session it returns the
   stored outcome and acts once.
8. Both paths: one `cmdId` sent by the exchange and by the parent phone's
   stream acts once.
9. Role: a watch cannot use `api.req`, `sub`, `hist.query` or `site.mode.set`.
   Demoting its phone to viewer turns its next command into `E_SCOPE_DENIED`.
10. Removal: removing the watch ends its session and silences its next X1.
    Removing the phone does the same for its watches.
11. Isolation: eight exchange sessions leave four stream sessions running.
12. Vectors: Swift and Go agree on the bytes of X1 to X3, as Go and TypeScript
    already do for the stream.

Devices, on a real watch, because the simulator allows all networking:

13. Phone off. Watch on known Wi-Fi, then on LTE. Charge now ends with the
    observed value on the watch. 20 runs each; p50 and p95 noted.
14. Phone locked in a bag, watch on its Bluetooth. The same.
15. Watch off the wrist: its key is locked and it sends nothing.
16. Remove the watch from the phone. Its next command fails within one
    request.

## Open decisions

[ADR 0009](https://github.com/srcfl/ftw/blob/master/docs/adr/0009-watch-exchange.md)
lists them. Until Fredrik answers, the recommendations here are the working
choice.
