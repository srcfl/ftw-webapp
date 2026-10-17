# FTW project stats

This Worker keeps project growth data in one small D1 database. It polls the
configured GitHub repositories, reads server-side traffic counts for
`app.ftw.energy`, accepts signed aggregate counts from the blind relay, and serves a
public and a private dashboard at `stats.ftw.energy`.

The public view follows the six active public product repositories: `ftw`,
`device-drivers`, `ftw-cloud`, `ftw-app`, `ftw-webapp` and `ftw-web`. Private
repositories, the archived `ftwdb` experiment and the solver demo are outside
these totals. Release labels name the newest published release among the
latest 100 releases, including beta releases. A new repository appears as
awaiting collection until its first snapshot arrives; missing data is not zero.

The public view shows repository data, web app traffic and aggregate daily
reports. Fleet totals stay hidden until at least `PUBLIC_MIN_REPORTS` reports
exist in the chosen period. Each version, device integration and other
dimension label also stays hidden until its own count reaches that threshold.
A report is one daily check-in, not one user or one box. The private view may
show smaller aggregate counts, but it requires a valid Cloudflare Access JWT.

## FTW Cloud transition

FTW Cloud is replacing the separate relay. This dashboard does not yet receive
Cloud usage statistics or the Cloud statistics consent flow's reports. It also
does not collect App Store installs or native app sessions. Native app and
Cloud development appear in the repository figures; those figures do not
measure use of either product.

The existing daily reports still reach this Worker through the relay's signed
export. Keep that ingest route until its replacement works. The public page
names this source and shows its age. Relay load stays in the private view as
migration diagnostics; it must never stand in for Cloud usage.

Before retiring the relay, move both Core's daily-report destination and the
aggregate export to an agreed replacement. FTW Cloud's statistics work needs
its own consent, ingest and privacy checks in `srcfl/ftw-cloud` and Core; a URL
change in this Worker cannot supply them. Do not combine legacy daily totals
with a new feed without handling overlap and their different consent rules.

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

Set `CLOUDFLARE_ZONE_ID` as a Worker variable. Give the Cloudflare token
`Account > Account Analytics > Read` and make sure its resource scope includes
the `ftw.energy` zone. The hourly collection asks for Cloudflare's server-side
visits, requests and response bytes for `app.ftw.energy` over the last 7 complete
UTC days. It uses one aggregate query per day to fit the zone's one-day query
limit. It sends no
browser script and stores no request rows, IP addresses or visitor ids.

The GitHub repository snapshot and site query run each hour. GitHub traffic
runs once a day because GitHub exposes it as a rolling daily window. The relay
pushes one aggregate snapshot every five minutes.

Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as Worker variables. Protect
`stats.ftw.energy/admin*` and `stats.ftw.energy/api/admin*` with one Cloudflare
Access application. The Worker also checks the token signature, issuer and
audience, so a route mistake fails closed.

Use a policy made for this app and include the GitHub organization `srcfl`.
Do not add GitHub as a separate login-method Include rule: Access joins Include
rules with OR, which would let any GitHub user through.

Set the same relay ingest secret and the Worker ingest URL on the relay host:

```sh
RELAY_STATS_EXPORT_URL=https://stats.ftw.energy/api/ingest/relay
RELAY_STATS_EXPORT_SECRET=replace_with_the_same_secret
```

The relay keeps working if export fails. It tries once at startup and then once
every five minutes.

## Retention

The hourly cleanup keeps only the data each dashboard window needs:

- 90 days of GitHub snapshots, relay snapshots, fleet daily totals and
  collector results;
- 30 UTC days of GitHub traffic, referrers and popular paths;
- the last 7 complete UTC days of site traffic.

Relay ingest also applies the 90-day relay and fleet limits, so those two
tables stay bounded even if a scheduled collection fails. Rows outside these
windows are deleted, not only hidden from dashboard queries.

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
- Fleet reports are daily reports, not users or unique installs. Public version
  and device integration names show which broad labels appeared in those
  reports. A device integration is a type, not a count of physical devices.
- The API keeps its legacy relay activity bands for compatibility. The public
  page does not render them. The private view shows current room and socket
  counts plus frame and byte deltas over the current relay process, capped to
  the last 24 hours. These counts do not measure FTW Cloud.
