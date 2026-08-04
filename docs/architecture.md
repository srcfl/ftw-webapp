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

- **The rendezvous secret has no home in the QR payload.** The fragment
  carries a version, the box's static key, a single-use pairing code and a
  LAN hint. Rotation needs a long-lived secret that is none of those. Until
  it has an explicit field with its own rotation path, handle rotation is
  specified but not provisioned.
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

## Deliberately not in v1

Each of these is deferred with a reason, not forgotten.

| Deferred | Why |
|---|---|
| Push and the event model | As large as the other three layers combined, and nothing in the thesis needs it. Safari also forbids silent pushes, so it can never be a sync engine. |
| WebRTC LAN carrier | Blocked on the iOS measurement above. |
| Support and managed-service grants | Real product need, zero proof value for v1. |
| Escrow recovery | Needs push to notify other devices. v1 recovery is another enrolled device or the button on the box. |
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
