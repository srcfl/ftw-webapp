# FTW webapp

Your home's energy, from wherever you are.

This is FTW's installable web client. It talks to the FTW box in your home,
which is the authority on your
energy system. Sourceful's cloud carries the traffic and cannot read it.

## Product direction and contributions

[The shared FTW vision](https://github.com/srcfl/ftw/blob/master/VISION.md) guides the client:
fast, honest live feedback; simple daily charging; useful expert access; and
clear outcomes for both people and authorized agents. The
[roadmap](https://github.com/srcfl/ftw/blob/master/docs/roadmap.md) states acceptance evidence.
Goals such as cloud MCP access are distinct from implemented protocol support.

Sourceful maintains the app. External users report needs and bugs through
[issues](https://github.com/srcfl/ftw-webapp/issues), not PRs.
See [CONTRIBUTING.md](CONTRIBUTING.md).

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

If a household asks, the cloud will also hold one sealed copy of its home, so a
new phone gets back in with a passkey instead of a trip to the box. Sourceful
holds a sealed copy it cannot open, with an opaque id and nothing beside it —
[`escrow/README.md`](escrow/README.md) is the claim, the file of fixed slots it
is stored in, and the tests. It is off until someone turns it on, and losing the
whole database costs a QR scan.

## Status

See [docs/architecture.md](docs/architecture.md) for the architecture and
[docs/protocol.md](docs/protocol.md) for the wire contract. Some design notes
record earlier delivery stages; use the current implementation, tests and
release evidence to establish what a particular box and app support.
The product vision is a target, not an availability list.

Not yet built: cloud MCP agent access and the WebRTC LAN carrier. The vision
sets the direction for agent access; the architecture records the LAN work.

## Running it

```bash
npm install
npm run dev
```

For local integration work, run `make dev` in
[FTW](https://github.com/srcfl/ftw). That starts simulated drivers and seeds
history, so no hardware is needed.

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
| `escrow/` | The sealed escrow — one slot per household, and it cannot open any of them |

`contract/registry.yaml` is the single source for every name shared with the
box. It generates TypeScript here and Go constants in the FTW repo, and CI
fails if the two drift. Do not hand-write those names in either language.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
