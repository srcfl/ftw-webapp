# The blind relay

Carries encrypted frames between an FTW box and the browsers and watches
allowed to reach it. It is the only remote path that carries commands, and it
cannot read a watt.
FTW Cloud, which a box owner may turn on for the iPhone app, is a separate
service that can read what the owner enabled. It never touches the relay
([ADR 0008](https://github.com/srcfl/ftw/blob/master/docs/adr/0008-ftw-cloud.md)).

```
box ──ws: uplink────▶ ┌────────────┐ ◀──ws──── phone
    ──ws: exchange──▶ │   relay    │
                      │  no keys   │ ◀──ws──── laptop
                      │ no traffic │
                      │   on disk  │ ◀──https── watch
                      └────────────┘
```

## Running it

```bash
npm run relay          # PORT=8787 HOST=0.0.0.0
```

Network settings and two state-file paths come from the environment. There is
no configuration file; every limit stays in `src/server.ts` or `src/limits.ts`
beside the code.

## What it does

One box uplink and up to four browser streams meet under a **rendezvous
handle**. Binary messages from the uplink go to every stream; binary messages
from a stream go to the uplink. Streams never reach each other.

The uplink is broadcast to all streams because the relay cannot tell which
stream a ciphertext belongs to without reading it, and reading it is the one
thing it must not do. At 512 bytes a second on the telemetry lane, four streams
cost two kilobytes a second. That is the right way to spend the bandwidth.

A watch cannot hold a stream: watchOS gives an app HTTPS and nothing lower. So
the box opens a second socket, the **exchange socket**, and a watch posts one
sealed message at a time. The relay draws a random 16-byte id, sends the id and
the body down that socket, and returns the answer that comes back behind the
same id. An exchange never takes one of the four stream places, no stream sees
one, and the exchange socket sees no stream frame.
[docs/watch-exchange.md](../docs/watch-exchange.md) has the wire.

## What it cannot do, and how you can check

Read `src/`. The small files are meant to be read: routing and
refusals in `server.ts`, rate limiting in `limits.ts`, the epoch clock and the
wire's constants in their own files, daily totals in `fleet.ts`, and the dead
man's switch in `deadman.ts`.

| Claim | Where to look |
|---|---|
| No keys, no decryption | Nothing in this directory imports a cipher |
| No parsing of payloads | The only property read off a routed message is `.length` |
| On the exchange socket, only its own id | `#onAnswer()` reads the first 16 bytes, the id the relay drew, and returns the rest unchanged |
| No compression | `perMessageDeflate: false` — a compressed frame's size depends on its content |
| No padding, no trimming | `send()` forwards the received buffer unchanged |
| No handle derivation | Needs a secret that never comes near here; see `src/lib/carrier/rendezvous.ts` |
| No storage of routed traffic | Rooms are a `Map` and are deleted with their last socket. An open exchange leaves its room's map when its answer goes or its timer fires |
| Bounded stored state | `deadman.json` holds sealed dead-man rows; `fleet-stats.json` holds daily counters for 90 days. Neither holds routed traffic |
| No record of who was here | `log` is given counts and statuses, and nothing about exchanges; `inspect()` is everything held, and holds counts. Caddy writes no access log line for `/x/` |

**The dead man's switch is the one thing the relay holds**, because it is the
one notification the box cannot push about itself: that it is gone. A box
leaves a sealed row — an opaque id (an HMAC of a secret that never comes
here), a push endpoint, a ciphertext encrypted at home with keys the relay
never had, a deadline, and a delivery authorisation the box pre-signed. While
the box's socket claims the id the switch is held; when the claim stays
dropped past the deadline, the relay posts the ciphertext, once, and will not
fire that id again until the box has been back — with a half-hour floor so a
flapping line is one message, not a night of them.

What a row undeniably tells the operator: that some box exists, which push
service its household uses, and — while a socket claims it, in memory only —
which connection is that box's. What it cannot tell: what the message says,
which household it is, or anything about the traffic beside it. The routing
path is untouched: a claim is one consumed word on the uplink, never routed,
and room bytes remain unread.

## Fleet statistics

`POST /fleet` accepts the seven-field `ftw.fleet/1` report from an FTW box once
a day. It contains the schema plus six coarse values: release version and
channel, driver types, battery-size range, price zone and install-age range.
There is no box id, key, serial, site name, counter or timestamp. The relay
validates the exact field set, increments the UTC day's counters and drops the
body. Only the latest 90 days of totals are written.

The TLS and relay process see the source address while the request is open.
Neither writes it. Rate limiting uses the same keyed, short-lived counter array
as relay joins, not an address list. The detailed totals are available on
loopback at `GET /fleet/stats`; Caddy returns 404 for that path publicly.

These are **reports, not unique boxes**. There is no id with which to dedupe,
and the public POST has no credential with which to prove that a report came
from a real box. The daily count is an operating estimate, not a billing or
security measure.

`tests/relay-blindness.test.ts` runs a real box against a real app across this
server, and a stand-in box and watch through the exchange. It collects every
routed byte, every logged line and everything in memory, and fails if a message
type, an op name, a device name or a watt reading is anywhere in it.
It first checks that the same detector catches the unsealed frames, because a
detector that catches nothing proves nothing. The dead man tests hold the new
claims the same way: the persisted file is byte-audited against the five
fields, a fired switch posts the ciphertext byte-identical, and the
constant-shape test still passes with the switch armed.

## The rendezvous handle rotates

A handle is what the box and the app call each other on the relay. A stable one
— a hash of the box's key, say — would work perfectly and hand the operator a
household identifier good for years: every connection, every outage, every
holiday, joined up under one string.

So the handle is derived per epoch, one hour long:

```
handle = HKDF-SHA256(secret, "ftw/rendezvous/v1/<epoch>")[0..16]
```

The secret is exchanged optically at enrollment, in the QR fragment, and never
travels through Sourceful. HKDF-Expand is a PRF, so without it two epochs'
handles are two unrelated strings and there is no function the relay can
compute that links them.

**The relay is not in that loop.** It never learns a handle before a peer uses
one, and it cannot derive the next. Its only contribution is the epoch
*number*, which it announces to everyone equally because it is its own clock:
peers guess the epoch from their own clock and put the guess in the join path,
and a wrong guess comes back corrected in the close reason. A box whose RTC
reads 1970 is right after one round trip.

**What this does not hide.** At a rotation the relay watches one handle go
quiet and another appear moments later, so it can correlate across a single
boundary by timing. Peers rejoin after a random delay to blur that, which makes
it unreliable rather than impossible. The claim worth making is the one that is
true: the relay cannot follow a household across months from an identifier we
handed it.

## Rate limiting without a list

The usual way to limit a service is a table keyed by client address, which is a
log of who connected and when — the thing this relay exists not to have.

Instead, per-socket token buckets live on the socket they limit and die with
it, so nothing is keyed by anything. Connection *attempts* have to be counted
across sockets, so they go into a fixed array of counters indexed by a keyed
hash of the caller's address, with the key drawn from the OS each minute and
thrown away with the counts. The array cannot be turned back into a list of
addresses and does not outlive the window. Slots collide, so a heavy caller
shares a limit with whoever hashes alongside them. That is the price of not
keeping the list, and it is paid on purpose.

## Wire

```
ws://host/r/<epoch>/<handle>/<box|app|exchange>
POST https://host/x/<epoch>/<handle>
```

Binary messages are routed. Text from a peer is a protocol error and closes the
socket, which keeps the routing path free of anything the relay would have to
interpret. Text from the relay is one of two words:

| Word | Meaning |
|---|---|
| `ready` | The other side of the room is here |
| `gone` | It left; the socket stays up and waits |

| Close code | Meaning |
|---|---|
| 4400 | Bad join, text on a binary channel, an oversize message, or an exchange answer of the wrong size |
| 4409 | Wrong epoch; the reason carries the right one |
| 4410 | The epoch turned over; the reason carries the new one |
| 4429 | Rate limited, room occupied, or the process is at its ceiling |

A single timer drives the heartbeat, the reaping of dead sockets and the
rotation check, so nothing the relay emits has a cadence that traffic can
influence.

### The exchange

The box joins with role `exchange`, one per room; the first holds it, as with
the uplink. Each message from the relay is `id(16) ‖ body`, and each answer
from the box is `id(16) ‖ reply`. The relay drops an answer whose id it is not
waiting for, and says no word on this socket: no `ready`, no `gone`.

A watch posts `content-type: application/octet-stream` and gets a status back.
No CORS header is ever sent, so a web page cannot read an answer.

| Status | Meaning |
|---|---|
| 200 | The box replied; the body is its reply, unchanged |
| 400 | The path, the content type or the body size is not one the route takes |
| 404 | No box on this handle now |
| 405 | Not a POST |
| 409 | Wrong epoch; the body carries the right one |
| 429 | Rate limited |
| 501 | A box is here but opened no exchange socket: it needs an update |
| 504 | The box did not reply within 10 s, or its exchange socket closed |

The limits, in `src/limits.ts`, keep no list: 30 requests a minute per address;
2 open and 30 a minute per room; 1 024 open in the process; a body of exactly
608 or 536 bytes in and at most 4 KiB back. During the five minutes a rotation
is spread over, `/x/` also takes the previous epoch, so a watch whose box has
not moved yet can find it.

## What it still knows

Honesty about the residue, in the spirit of `docs/architecture.md`:

- That some opaque handle is online, and roughly how much traffic passed.
- Client IP addresses, for as long as a TCP connection is open. They are not
  written down, and TLS termination in front of this will see them too.
- Timing. Lane 0's fixed size and constant cadence are what keep that from
  saying anything about the house.
- The six coarse fleet labels during one daily HTTP request. It stores their
  daily totals, not the request or the address that sent it.

While a watch's request is open, it also knows what
[docs/watch-exchange.md](../docs/watch-exchange.md#what-the-relay-must-never-learn)
lists:

- That someone with this hour's handle sent a request at a given time from a
  given address. [architecture.md](../docs/architecture.md#what-is-not-yet-true)
  names the same channel for app-to-box frames, which leave only on a person's
  action.
- Whether a request opens a session, from its size. The order already told it
  that.
- How long the box took. A refusal answers in milliseconds; an applied command
  waits for the charger. ADR 0009 measures whether that gap shows through
  network jitter, and adds a fixed floor only if it does.
- That this handle had an HTTPS client this hour.

It writes none of these down. No log line names a handle, an address, a size
or a time, and Caddy writes no line for `/x/`.

## Not here yet

- TLS. Terminate it in front; this speaks plain WebSocket.
- Horizontal scaling. Rooms are in one process, so a household's box and its
  phones must land on the same instance. Sharding on the handle would work and
  would need the handle to reach the load balancer, which is worth thinking
  about before doing.

## License and source

This service uses AGPL-3.0-only with the Energyplan combination permission.
See [LICENSE](../LICENSE), [LICENSING.md](../LICENSING.md) and
[NOTICE](../NOTICE). Commercial use is allowed under those terms.
The container serves its matching build source at `/source`. Keep that offer
available to network users and include your changes when hosting a modified
version. The archive contains build-time source, not runtime household data.
