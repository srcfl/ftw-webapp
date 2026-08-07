# Architecture

What was decided, what was rejected, and why. Read this before changing
anything structural.

## The model

**Edge-authoritative, client-local, cloud-blind.**

The box at home is the system of record. It measures, controls, stores the
full history, holds identity and decides what is safe. It works with the
cloud switched off.

This app is a cached projection of the box. It renders from its own store
first and replaces that with fresher data when a carrier answers. It expresses
intent; it never decides.

Sourceful's cloud serves this bundle and relays encrypted frames. It knows
that an opaque handle is online and roughly how much traffic passed. It cannot
read a watt, a device name or a command.

## One origin, three carriers

The app lives at one origin. **The box is never an origin and never serves
HTML.** Everything persistent — service worker, IndexedDB, keys, the passkey
— belongs to that single origin, so there is one installation, one cache and
one identity.

Behind a common session abstraction sit three carriers:

| Carrier | Role | Status |
|---|---|---|
| Relay | Default, and the only remote path | v1 |
| Cache | Read-only view when nothing reaches the box | v1 |
| WebRTC DataChannel | Opportunistic LAN shortcut | after measurement |

The app picks silently. There is no home/away switch, because the user does
not care which wire carries the frame — only how fresh the number is.

**Cache is a carrier, not a failure state.** Treating it as one is what makes
the app open instantly instead of showing an error while it reconnects.

### Why WebRTC for the LAN, later

A cloud-origin page cannot open an insecure connection to `192.168.x.x`, and a
box on a private network has no CA-signed certificate. WebRTC sidesteps both:
`RTCPeerConnection` is exempt from mixed-content rules, and DTLS authenticates
by certificate fingerprint — which the app pins optically from the QR code at
enrollment. No DNS, no ACME, no certificate warning.

It is deferred because ICE-lite with a hand-built SDP answer is weeks of work,
the relay at 200–600 ms already satisfies "readings appear immediately", and
local network access is being permission-gated in both Chrome and Safari. The
carrier abstraction ships with two implementations so it can be added without
changing anything above it.

**Open risk:** Safari appears to filter ICE host candidates without camera
permission. If so, iPhone has no LAN path when the internet is down. A rig —
a Pi and a static page, four yes/no gates — settles it before that work
starts. Building the LAN carrier before running it would be a guess.

## What was rejected

**Per-box public DNS with a real certificate** (the Plex `plex.direct`
pattern). It needs recursive DNS over the WAN to reach a box three metres
away, so it fails exactly when the internet does — the case it was supposed
to solve. DNS rebinding protection in ordinary consumer routers breaks it
permanently, and the fix requires the homeowner to edit router configuration.
Every issued certificate lands in Certificate Transparency, publishing the
installed base as a permanently enumerable list along with each home's
internal addressing. And because the cloud would own both the zone and the
ACME delegation, the cloud could issue a valid certificate for any box and
intercept the "secure" LAN path. The certificate machinery makes the threat
model worse, not better.

**The box serving the app on the LAN**, giving two origins. IndexedDB, OPFS,
Cache Storage, service worker registration and push subscriptions are all
origin-partitioned without exception. That means two identities, two caches,
two installations — two home screen icons for one product, one of which
breaks the moment the user leaves the house. It also forces the RP ID wide
enough that any origin under the domain could derive the encryption key.

**TURN and WebRTC over the WAN.** The relay with Noise is equally provable as
blind and is one service instead of two, without bandwidth that scales with
the share of households behind hard NAT.

**WebTransport with `serverCertificateHashes` as the LAN carrier.** The
implementation has landed but exposure on iOS is unmeasured, and the
certificate must be short-lived enough to need hash chains synced in advance.
Tracked as a replacement for the WebRTC carrier — if Apple exposes it, it is
simpler and we switch.

## Identity

No accounts. No email, no password, no username. A passkey is the identity.

The RP ID is scoped to the app subdomain, **not** the registrable domain. This
is a security decision, not a convenience one: WebAuthn PRF output is bound to
the RP ID rather than the origin, so the RP ID's scope decides which origins
may derive the encryption key. Since the box is never an origin, a wider scope
buys nothing and costs the guarantee.

Key hierarchy:

- PRF derives a wrapping key, used at enrollment and before privileged
  commands.
- A device key is stored wrapped, with one wrapped copy per registered
  credential — an Apple passkey and an Android passkey produce different PRF
  output, so classic key wrapping covers both.
- **The cache key is separate and is not PRF-wrapped.** It is a
  non-extractable AES-GCM key in IndexedDB. This is what makes a cold start
  paint before any Face ID prompt, and that is the whole point of the app. The
  honest claim: it resists offline disk reads and code on other origins. It
  does not resist an attacker holding the unlocked device.

Enrollment is optical. The QR carries the box's static key, a single-use
pairing code and a LAN hint, all in the URL fragment so none of it reaches
any server. The trust anchor arrives out of band, which is why a hostile or
compelled cloud can deny service but cannot impersonate a box.

## Reaching the box's own API

The app could name six things to ask its box. The box's own web page can name
132. Every new view therefore cost a box release, so the session now carries
the box's HTTP API directly: `api.req` in, a status and a byte stream back. A
view over a route the box already serves is now the app's own work alone.
The wire is in [docs/protocol.md](protocol.md); what belongs here is why it is
not a widening of the trust boundary.

**Those 132 routes are already served on the home LAN with no
authentication at all.** Anything on the network can call them. Reaching the
same handlers through a Noise session, pinned to a device the box enrolled
optically, with a role attached and a passkey ceremony in front of every
write, is strictly stronger than what households run today. This is a security
improvement; the LAN is the thing still waiting to be fixed.

Five things keep it from becoming a hole:

- **Only `/api/`.** The box's static handler stays unreachable. Serving HTML
  through the session would make the box a second origin under another name,
  which is the arrangement rejected above and for the same reasons.
- **A route nobody priced is closed.** The box decides what a route costs
  beside the handler, one line per route, and never from the method — a GET
  that hands out a password and a POST that drives a battery both read as
  ordinary from their verb. A path no route claims is refused rather than
  served. The cost is a view the app cannot draw until somebody names the
  path; the alternative was a control a stranger could reach.
- **No headers field on the wire.** The caller's identity is put on the
  request context inside the box process by the session that authenticated it.
  There is no byte a client can send that becomes a claim about who is asking.
- **Actuation keeps its own door.** An HTTP request has no expiry, and the
  invariant is that a command carries one and is revalidated against fresh
  state at the dispatch boundary. So routes that move energy are refused
  through the passthrough for every role and stay on `cmd`.
- **A guest's role is the box's to decide.** Inviting someone asks for a
  viewer, and the box grants a viewer over a session whatever the request
  says — an owner is admitted at the box, in the house. The app sends the
  role in the body, where the box reads it, and refuses to draw a square the
  box did not describe as view-only. It went in the query string for a
  release, where the box does not look; a role that does not arrive used to be
  read as an owner's, so the invite button asked to share a view and handed
  over the house. This app's simulator now refuses that shape too, because a
  peer that shares the app's misreading hides it.

The honest limit: a role is checked at the box, and this app hides what a
viewer cannot use. Hiding is presentation. Nothing here is what stops a
modified client — an enrolled device could already send a command before any
of this existed. What the box adds is the part only it can do: refuse, count
and record.

## Privacy, stated honestly

The relay cannot decrypt. That is architecture, not policy, and a CI test
proves it by dumping the relay's database and failing on any recognisable
plaintext or numeric pattern.

Frames on the telemetry lane are padded to a fixed size and sent at a constant
cadence whether or not anything changed. Without this, a 1 Hz power stream
leaks the household's load pattern through perfect encryption — when people
wake, cook, leave and come home. A second test asserts that frame length and
frames-per-minute are constant regardless of how much state changes.

**The cloud still serves the JavaScript.** A blind relay does not change that:
we could ship a build that reads decrypted data in the browser and sends it
home. The mitigations are an append-only build transparency log, a service
worker that refuses a bundle whose hash is not in it, no third-party scripts
and no analytics. They reduce the risk; they do not remove it.

So the claim is **"Sourceful's services cannot decrypt your energy data"** —
not "it is mathematically impossible for Sourceful to ever access anything".
The second sentence is marketing. The first is true.

### What is not yet true

An adversarial review of the crypto, identity and relay layers found the
content half of that promise sound and the metadata half not. These are open,
and listed here rather than in a tracker because a privacy claim with quiet
exceptions is worse than no claim.

- **The rendezvous secret cannot yet be rotated from a session.** The v2 QR
  payload carries one, so the handle is no longer a hash of a key that never
  changes, but replacing it still means scanning a new code. The field exists
  so that a `rendezvous.rotate` command can arrive later without another
  payload version.
- **The box authenticates nobody.** Noise IK proves the box's identity to the
  app, not the reverse. The pairing code that would close it is parsed and
  then unused. So today the guarantee is one-way.
- **The app-to-box direction has constant frame size but not constant
  cadence.** Frames leave only on user action, so the relay can see when
  someone opened the app and how many times — a much thinner channel than the
  1 Hz telemetry stream, and the one that survives its padding.
- **The passkey gate can degrade to no gate.** A failed ceremony that is not
  a user cancellation currently falls back to a local key with no prompt,
  and that copy persists.
- **The relay's rate limiter keys on the socket address**, which behind the
  documented TLS terminator is one address for everyone.

Fixed since that review: a handshake can no longer be split twice (which
would have reused a nonce); the relay can no longer name the epoch and so can
no longer choose the client's handle; clearing a device now clears the sealed
projection along with the identity, so a phone handed on cannot paint the
previous household's home.

### What the Go cross-check found

Building the box's half of the protocol and running both implementations
against each other found things neither suite could see alone. Two are worth
recording because of *how* they hid.

**The PV sign was wrong in this app, and the simulator agreed with it.**
FTW's convention is that PV is never positive — `pv_w = -3000` means
generating 3 kW, and `grid_w = load_w + bat_w + pv_w`. The simulator emitted
it positive and the explanation layer tested `solar > 0`, so against real
hardware every sentence about solar would have been wrong. Every test passed,
because the simulator carried the same mistake. That is the one failure mode a
simulator cannot catch: not a case it fails to cover, but an assumption it
shares.

**`controlRev` is inert on both sides.** The app sends `expect.rev` and the
box compares it, but nothing increments it, so the conflict check described
above currently passes everything. Worse, when something does start bumping
it, the app has no way to resync mid-session. Fixing it needs both sides and
is not done.

## The escrow, and the boundary it moves

Adding the app to the home screen gives it storage of its own, so it launches
with an empty vault and an empty site list. The passkey survives — it syncs
through the platform's keychain — but what the passkey protected did not, and
the only offer that screen could make was "scan the code on your box", for a
box the phone was already paired to.

So a household may ask Sourceful to hold **one sealed copy**, at
`escrow.ftw.energy`. It is opt-in per household and off until someone asks. The
claim, in the words the opt-in screen uses:

> **Sourceful holds a sealed copy it cannot open, with an opaque id and nothing
> beside it.**

The copy is the recovery blob: the device's Noise static and, per home, the box
key and the rendezvous secret. It is AES-GCM under a key derived from PRF
output and padded to a fixed 512 bytes, so its length says nothing about how
many homes are inside. The id is HKDF over the same PRF secret under a
different `info` string — a sibling of the key, never derived from it — so a
fresh device produces both from the passkey alone, in one prompt, and the id
Sourceful holds says nothing about the key.

`escrow/README.md` carries the claim table an outsider can check, the rollback
guard, and why there is no delete. Three things belong here instead, because
they are decisions rather than mechanism.

**It moves a boundary, for the households that opt in.** The passkey's vendor
— iCloud Keychain, Google Password Manager — can now restore access to the
house, because anyone who can complete that ceremony derives both the id and
the key. That is the same boundary those vendors already hold for passwords,
and it is the trade the feature *is*. The screen says so in a sentence before
the button, not afterwards.

**A recovery is invisible to the household.** Restoring puts back the same
device scalar, so `appenroll.Authorise` takes its already-authorised branch and
only stamps `lastSeenMs` — the box cannot tell a recovery from a reconnect, by
design, because that is exactly what makes recovery need no pairing code. There
is no notification and none is planned: the app has no push, and a doc that
promised one would be promising more than the code does. The counter-measure is
the one that already exists — the box can revoke the device.

**Losing the database costs a QR scan.** Nothing depends on the escrow. Worst
case is today's behaviour for every household, which is what makes it safe to
operate and why it has no backup story to rehearse.

**The store is one file of fixed slots, and nothing else on the host.** Where a
record sits is a function of its id and of nothing else. Every slot is the same
size, every one of them is filled with random bytes when the file is made, and a
save lands in place — so there is no arrival order to remove, because there is
none to begin with. No journal, no compaction, no temporary copy, no second
file: `ls` on the volume shows one. The file is written in full when it is
created rather than merely declared, because a file whose blocks are handed out
the first time each is touched has the arrival order in its block map, one layer
below where anybody was looking. `escrow/layout.md` is the format,
`escrow/README.md` is the claim table an outsider can check, and
`escrow/deploy/README.md` has the measurements, including the block map and
every other layer that could keep a time — the runtime, the proxy, the platform.

**Nothing off the shelf could hold that claim**, and each candidate was run
rather than reasoned about. A file per household is a created-at per household,
and so is an object store's `LastModified`. Redis answers `OBJECT IDLETIME` per
key from memory with no schema anywhere near it. A log-structured store keeps
every write in arrival order before any compaction, and a relational one keeps
the transaction that wrote each row in a system column. A b-tree writes
different bytes for different arrival orders. The table of what each one did is
in `escrow/README.md`. The pattern is worth more than the table: the arrival
order is not a feature any of them chose to keep, it is what a tree, a log or a
file-per-key **is**, and chasing it out of one a layer at a time is fighting the
tool.

Two things it is deliberately not. It is **not the relay**, and not only
because the relay's claim is that it stores nothing: one host seeing an escrow
write and a rendezvous join in the same second could tie the escrow's stable
pseudonym to a handle, which is what the hourly rotation exists to prevent. And
it is **not the app origin**: `wrangler.jsonc` has no `main` on purpose,
because a hand-made Worker in front of the assets once swallowed `/sw.js` and
the app could not open offline.

**The claim has been false six times, each one a layer below the last fix.**
It ran on a managed database first, whose point-in-time recovery is always on
and reaches back thirty days: restore at T and at T plus a minute, diff the two,
and you have which id was written in that window — three columns, no created-at,
and the claim false in operation the whole time. Then in the proxy in front of
it, whose two logs kept a line per request with the addresses and the URI
deleted and the byte counts left in: a save read 769 bytes and answered 13, a
read of a copy that was there 63 and 707, one that was not 63 and 2. Beside a
timestamp and a stable pseudonym, that is a household's activity record, and a
filter cannot remove it because a byte count is not a field — so both logs are
discarded rather than filtered, and the wire is padded to one length in each
direction the way lane 0 is. Then in the storage engine's own file, where a page
kept its cell contents in write order, so sorting a page's cells by descending
offset handed back the order households joined. Then in the fix for that, where
a `VACUUM` after every save wrote an arrival-ordered copy of the whole database
beside it as a rollback journal — and a household leaving is a save, so the
journal held the leaver's ciphertext on the way out. **And then here.** The
store was rebuilt, `escrow/README.md` was rewritten around it, and this
document went on describing the store that had just been replaced — stating the
third and fourth failures as the guarantee that made the claim safe. Nothing
goes red when a document goes stale, which is why a dead store lives longest in
one, and why `tests/escrow-claims.test.ts` now reads this section.

**And then on the clock, which is the first one that leaves nothing to dig up.**
An accepted write pays two fsyncs and a read pays none, so a save answers in
3.10 ms where a read answers in 1.07 — and the service is one process doing its
whole read-decide-write synchronously, so an fsync stops the event loop and
every request already in flight waits for it. That hands anybody who can send a
request the fact that a write landed, and about when. Measured through the image
the `Dockerfile` builds, behind the deployment's own proxy, over TLS.

**It is the sixth, and it is the first one being written down rather than
closed.** That is a decision, so it belongs here. The five before it each gave up
a fact about a *household*: which id was written when, in what order, whose
ciphertext survived a leave. This one gives up "a write landed, about now" to
somebody probing the service while it happens — no id, no household, no order.
Four attempts to get one of those out of it are in `escrow/README.md` with what
each measured, and all four came back a coin. What is left is a count of writes
over time: aggregate information about Sourceful's own service, and over weeks a
growth rate we would not publish. Closing it means every request pays the two
fsyncs, so a read goes from 1.07 ms to 3.10 ms and the disk takes all the traffic
as well, in exchange for a channel that names nobody. So it is priced in
`escrow/README.md` under "what it still knows" rather than removed — and the
decision holds only for as long as it names nobody, which is why the four
attempts are written down with their numbers instead of summarised as "we
checked".

**The opt-in screen keeps its sentence, and that is a decision too.** What
leaks is a fact about Sourceful's own traffic rather than about the household
reading the screen — no id, no household, nothing they could act on if they
were told, and nothing they could choose differently about. A line about
fsyncs before the button would hand somebody a question they cannot answer in
exchange for a risk they do not carry. So this one is written down for the
outsider who checks the service, in `escrow/README.md`, and the screen goes on
saying what it holds.

Four lessons, and they generalise past this feature. A privacy claim that only
the code has been checked against has been checked halfway; one that has not
been checked by running the thing has not been checked at all; the document of
record is a layer, so it is checked like one; and a channel left open has to be
priced in numbers, because "it names nobody" is a measurement rather than an
opinion.

## Deliberately not in v1

Each of these is deferred with a reason, not forgotten.

| Deferred | Why |
|---|---|
| Push and the event model | As large as the other three layers combined, and nothing in the thesis needs it. Safari also forbids silent pushes, so it can never be a sync engine. |
| WebRTC LAN carrier | Blocked on the iOS measurement above. |
| Support and managed-service grants | Real product need, zero proof value for v1. |
| Delegation, installer role, per-asset constraints | Two roles cover the demo: owner and viewer. |
| Multi-site, i18n, offline command queue | Additive, none load-bearing. |
| Session resume, dictionary cache, deflate | Solve bandwidth problems that do not exist at 2 kB snapshots. |
| Bundle signing in the service worker | Keep "no skipWaiting" now, which is free; add the signature with the transparency log. |

## The demo that proves it

If this sequence feels like magic, the product is real:

Open a URL on an iPhone. Add it to the home screen. Scan the QR on the box.
Face ID. The energy flow appears immediately. Close the app and reopen it —
no loading screen. Leave the house; the same view arrives over the encrypted
relay. Share read-only access with someone; they create a passkey and see only
what was shared. Revoke it, and their session dies mid-stream. Then inspect
the cloud's database and find no energy data in the clear.
