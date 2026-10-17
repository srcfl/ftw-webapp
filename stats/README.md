# FTW project stats

This Worker keeps project growth data in one small D1 database. It polls the
configured GitHub repositories, reads server-side traffic counts for
`app.ftw.energy`, polls public FTW Cloud daily reports and usage cells, keeps the retired relay archive, and serves a
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

## Relay retirement

The separate relay is retired. Earlier reports remain as an archive and do
not measure current Cloud use. Core's anonymous daily reports now go to
Cloud; the Worker reads its thresholded public view at `/v1/fleet/public`. They still cannot count unique installations.

The installation estimate divides reports from the last seven complete UTC
days by seven, then rounds to a whole installation. Core normally reports
once a day. Missing or privacy-withheld days hide the estimate; stale source
data is marked. Opt-outs, offline boxes, failed sends, restarts and test boxes
can change it. It estimates active reporting installations, not people or
all installations ever made. Cloud holds imported relay history, so the page
uses the Cloud view in place of the archive and never adds them together. The separate usage
policy below supplies installation, capacity and energy cells. Never merge
these two report types or treat check-ins as people.

The signed legacy ingest route stays for compatibility. It accepts group
counters only, never routed frames, room handles, box ids, serials, IP
addresses, site names or raw household reports.

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
runs once a day because GitHub exposes it as a rolling daily window. Cloud usage collection also runs hourly. The retired relay no longer
supplies an active source.

Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as Worker variables. Protect
`stats.ftw.energy/admin*` and `stats.ftw.energy/api/admin*` with one Cloudflare
Access application. The Worker also checks the token signature, issuer and
audience, so a route mistake fails closed.

Use a policy made for this app and include the GitHub organization `srcfl`.
Do not add GitHub as a separate login-method Include rule: Access joins Include
rules with OR, which would let any GitHub user through.

Historical relay export configuration (retired; do not set up again):

```sh
RELAY_STATS_EXPORT_URL=https://stats.ftw.energy/api/ingest/relay
RELAY_STATS_EXPORT_SECRET=replace_with_the_same_secret
```

The retired relay exporter used to retry every five minutes. It is no longer
a source for current activity.

## Retention

The hourly cleanup keeps only the data each dashboard window needs:

- 90 days of GitHub snapshots, relay snapshots, fleet daily totals and
  collector results;
- only the latest thresholded Cloud daily-report view, removed if over 90 days old;
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

## Cloud usage

The hourly collector reads only public group cells from
`https://cloud.ftw.energy/v1/stats`. D1 keeps those published snapshots for
90 days. It never receives a home id, stats id or per-home reading. Missing,
stale and privacy-withheld values remain distinct from zero.

The paired Core and Cloud changes implement the separate policy
`ftw-project-stats-2026-10-v1`. Owners must accept it before their box sends
new fields; old consents do not enable them. Cloud must also advertise the exact
policy after the C8 DPIA review. An HTTP 503 with `FTW-Statistics-State: disabled`
is an expected waiting state, not a collector failure. Until those changes are deployed
and boxes report, the page shows an awaiting-source state. The public view
requires at least 20 homes per cell and no home above 30 percent of a sum.

Relay is retired. Earlier relay reports remain as an archive; they are
check-ins, never unique users or installations. The legacy signed ingest
route remains for compatibility and is not the Cloud usage source. GitHub
charts keep saved subtotals with repo coverage; star lines break when the
set changes, so adding repositories cannot look like organic growth.
