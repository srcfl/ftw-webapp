# FTW webapp — project guide

The FTW client. TypeScript and Svelte 5, built with Vite, shipped as a static
installable web app. It talks to an FTW box over an encrypted session; the box
is the authority and this app is a cached projection of it.

Read [docs/architecture.md](docs/architecture.md) before changing anything
structural, and [docs/protocol.md](docs/protocol.md) before touching the wire.

## Non-negotiable invariants

These exist because breaking one of them breaks a promise made to users.

- **Never fake live.** Every reading carries its age. If the box is
  unreachable, the app shows the last value with its timestamp — never a
  stale number styled as current.
- **Freshness is two fields, never one.** `carrier` (relay, cache, none) and
  `srcState` (live, lagging, stale, down, never) are orthogonal. Collapsing
  them into a single enum cannot express "connected, but the inverter went
  quiet 40 seconds ago", which is the case users most need to see.
- **The app expresses intent; the box decides.** No control logic here. A
  command carries an expiry and preconditions, and the box revalidates
  against fresh state before acting. A queued command is never replayed
  silently.
- **Positive watts flow into the site, negative out.** FTW's convention. The
  UI never shows a raw minus sign — it says "drawing" or "exporting".
- **Lane 0 frames are byte-identical in length and constant in cadence.**
  Padding is not decoration. A variable-length 1 Hz power stream leaks the
  household's load pattern to the relay operator through perfect encryption.
  A test enforces this.
- **Local storage is a cache, never the original.** Browsers evict it. The
  box holds the record.
- **The cache key is not PRF-wrapped.** Cold start must paint before any
  passkey prompt. PRF gates enrollment and privileged commands, not reading.
  The honest claim is that the cache resists offline disk reads and other
  origins, not that it resists an attacker with the unlocked device.
- **Never hand-write a name shared with the box.** Scopes, capabilities,
  error codes and field ids come from `contract/registry.yaml`.

## Conventions

- Components read design roles (`--surface-raised`, `--fg-dim`), never raw
  colour values. The palette lives in `src/styles/tokens.css` and is shared
  with FTW's on-box UI — keep them in step.
- Error codes are stable `E_`-prefixed strings with machine-readable args.
  The box sends codes; this app owns all prose. The one exception is push
  payloads, where the box must render text — those templates are generated
  from this app's catalogue in CI.
- Tests sit beside the code as `*.test.ts`. Full-flow tests live in `tests/`.
- Prefer explicit state over clever reactivity. A 1 Hz stream must not
  recompute the tree; field cells are `$state.raw` and updated by fid.

## Build and test

```bash
npm run dev       # dev server
npm test          # unit and contract tests
npm run check     # types
npm run verify    # all of the above plus a production build
```

Run the narrow test while iterating, `npm run verify` before handoff.

## Working alongside other people

Several people and agents work on FTW at once. These rules come from
[the FTW repo](https://github.com/srcfl/ftw) and apply here too.

- Read a pull request's reviews before judging it.
- Check for open PRs touching files you are about to change. One that exists
  has right of way.
- "This already exists" needs evidence of the right kind: a test or a run for
  behaviour, a rendered comparison for anything visual.
- Prefer small PRs in one area.
- Review UI changes in a browser. Reading the source is not enough.

Planning documents and agent notes stay out of the repository. Commit the
change, its tests and a changeset; put the reasoning in the PR description.

## Related

- [srcfl/ftw](https://github.com/srcfl/ftw) — the box. Go core, Lua drivers,
  Python optimizer. Its `AGENTS.md` carries the safety invariants that govern
  anything talking to it.
- [srcfl/ftw-web](https://github.com/srcfl/ftw-web) — the website.
