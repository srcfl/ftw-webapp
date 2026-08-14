# FTW project stats

This Worker keeps project growth data in one small D1 database. It polls the
configured GitHub repositories, reads server-side traffic counts for
`ftw.energy`, accepts signed aggregate counts from the blind relay, and serves a
public and a private dashboard at `stats.ftw.energy`.

The public view shows repository data. Fleet totals stay hidden until at least
`PUBLIC_MIN_REPORTS` reports exist in the chosen period. A report is one daily
check-in, not one user or one box. The private view may show smaller aggregate
counts, but it requires a valid Cloudflare Access JWT.

The service never accepts routed frames, room handles, box ids, serials, IP
addresses, site names, or raw fleet reports. The relay signs one body made from
process counters and the daily fleet totals it already holds.

## Set up

Create the D1 database, copy its id into `stats/wrangler.jsonc`, then apply the
migration:

```sh
npx wrangler d1 create ftw-project-stats
npx wrangler d1 migrations apply ftw-project-stats --config stats/wrangler.jsonc --remote
```

Set three Worker secrets:

```sh
npx wrangler secret put GITHUB_TOKEN --config stats/wrangler.jsonc
npx wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN --config stats/wrangler.jsonc
npx wrangler secret put RELAY_INGEST_SECRET --config stats/wrangler.jsonc
```

Set `CLOUDFLARE_ZONE_ID` as a Worker variable. Scope the Cloudflare token to
Account Analytics Read and only the account that holds `ftw.energy`. The daily
query asks for Cloudflare's server-side visits, requests and response bytes for
the apex host. It sends no browser script and stores no request rows, IP
addresses or visitor ids.

Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as Worker variables. Protect
`stats.ftw.energy/admin*` and `stats.ftw.energy/api/admin*` with one Cloudflare
Access application. The Worker also checks the token signature, issuer and
audience, so a route mistake fails closed.

Set the same relay ingest secret and the Worker ingest URL on the relay host:

```sh
RELAY_STATS_EXPORT_URL=https://stats.ftw.energy/api/ingest/relay
RELAY_STATS_EXPORT_SECRET=replace_with_the_same_secret
```

The relay keeps working if export fails. It tries once at startup and then once
every five minutes.

## Metric meanings

- Stars, forks, pull requests and issues come from GitHub.
- Views and clones use GitHub's rolling traffic data. GitHub only returns the
  recent window, so the daily collector saves it for longer trends.
- Site visits are Cloudflare entry visits, not users or unique people. One visit
  can include more than one page view. Cloudflare may sample these counts, so
  use them as a trend. Requests and data transfer use the same server-side query.
- Unique visitor and cloner totals are per repository. Adding repositories can
  count the same person more than once.
- Contributor identities are also per repository and include bots. The same
  person can appear in more than one repository total.
- Fleet reports are daily reports, not users or unique installs.
- Relay rooms and sockets are current aggregate process counts. Frames and
  bytes are totals since the relay process started.
