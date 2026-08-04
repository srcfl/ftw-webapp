# FTW webapp

Your home's energy, from wherever you are.

This is the FTW client — an installable web app that replaces a native mobile
app. It talks to the FTW box in your home, which is the authority on your
energy system. Sourceful's cloud carries the traffic and cannot read it.

## The shape of it

```
┌──────────────────────────────────────────────────────┐
│                      FTW webapp                      │
│  UI · local cache · encrypted keys · passkey         │
└──────────────┬─────────────────────┬─────────────────┘
               │                     │
        LAN (later)           encrypted relay
               │                     │
               ▼                     ▼
┌──────────────────────┐  ┌──────────────────────────┐
│      FTW at home     │  │  Sourceful cloud plane   │
│                      │  │                          │
│  control · safety    │  │  serves this bundle      │
│  full history        │  │  blind connection relay  │
│  devices · optimizer │  │  opaque site presence    │
│  identity · grants   │  │                          │
└──────────────────────┘  └──────────────────────────┘
```

Three claims hold this together:

**The box is the record.** It measures, controls, stores the full history and
decides what is safe. It works with the cloud switched off. The app holds a
cached projection of it, never the original.

**The app renders from its own cache first.** Press the icon and readings are
on screen in the first frame, timestamped honestly, while fresher data is
fetched behind them. There is no spinner on a white background.

**The cloud is blind.** It serves this bundle, relays encrypted frames and
knows which opaque handle is online. It cannot read a watt, a device name or
a command. This is enforced by the protocol, and a CI test dumps the relay's
database and fails if anything recognisable is in it.

## Status

Early. The architecture is decided and the protocol is specified; the client
is being built against a box simulator. See [docs/architecture.md](docs/architecture.md)
for what was decided and what was rejected, and [docs/protocol.md](docs/protocol.md)
for the wire contract.

Not yet built: push notifications, the LAN carrier, sharing beyond two roles,
multi-site, recovery by escrow. Each is listed with its reason in the
architecture doc rather than left implied.

## Running it

```bash
npm install
npm run dev
```

The app needs a box to talk to. Until the simulator lands, point it at a local
FTW with `make dev` in [forty-two-watts](https://github.com/srcfl/ftw) — that
starts simulated drivers and seeds history, so no hardware is needed.

```bash
npm run verify
```

Runs type checks, tests and a production build. Green before every handoff.

## Layout

| Path | What lives there |
|---|---|
| `src/lib/protocol` | Wire format, capability negotiation, snapshot and deltas |
| `src/lib/carrier` | The carrier abstraction: relay, cache, and later WebRTC |
| `src/lib/crypto` | Noise IK, the passkey key hierarchy |
| `src/lib/identity` | Enrollment, principals, grants |
| `src/lib/store` | IndexedDB — the local projection |
| `src/lib/ui` | Components |
| `src/views` | Screens |
| `contract/` | The shared registry: scopes, capabilities, error codes, field ids |
| `relay/` | The blind relay itself — the server this app's frames pass through |

`contract/registry.yaml` is the single source for every name shared with the
box. It generates TypeScript here and Go constants in the FTW repo, and CI
fails if the two drift. Do not hand-write those names in either language.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
