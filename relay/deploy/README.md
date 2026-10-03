# Running the relay

One small instance in eu-central-1, Caddy in front for TLS, the relay behind it
on loopback. That is the whole deployment.

It is deliberately not more. Routed rooms live in memory and die with their
last socket, so a restart costs every peer one reconnection. One named volume
holds two bounded JSON files: sealed dead-man rows and 90 days of anonymous
fleet totals. There is no database.

## Why one instance

A box and its phones must land on the same process: the room is a `Map` entry,
and two processes cannot share one. Sharding would mean a load balancer routing
on the rendezvous handle, which is precisely the household identifier the design
keeps from the infrastructure.

One instance carries this comfortably. Each paired home is one uplink plus up to
four browser streams, all idle most of the time; the ceiling in the code is 4096
sockets. Before that becomes the limit, the thing to change is the routing
design, not the instance size.

## The instance

A `t4g.small` is enough — the relay routes opaque frames and does no
cryptography. Its own blast radius on purpose: `i-0e8fec73834292798` carries
only the FTW relay, so it does not share a fate with Buzz or services being
retired.

Security group: 80 and 443 from anywhere (Caddy needs 80 for ACME), 22 from
wherever you administer it. Nothing else — 8787 is bound to loopback and must
stay there, because that is what makes trusting `X-Forwarded-For` safe.

DNS: an A record for `relay.ftw.energy` at the instance's elastic IP, in the
Cloudflare zone. **Grey cloud, not orange.** Proxying WebSockets through
Cloudflare adds a hop that can read frame timing and length, and the whole point
of this service is that the party carrying the traffic learns as little as
possible. Caddy needs to reach Let's Encrypt directly for ACME anyway.

## Bringing it up

`bootstrap.sh` is the whole thing — pass it as EC2 user-data on a fresh
Amazon Linux 2023 arm64 instance, or run it by hand on an existing one. It is
idempotent.

The host has no SSH and no key pair. Access is through SSM:

```bash
aws ssm start-session --region eu-central-1 --target <instance-id>
```

Caddy gets its certificate on first start, which needs the DNS record to exist
already. Check it took:

```bash
curl -s https://relay.ftw.energy/healthz
```

`ok` means the whole path works: DNS, certificate, proxy, relay.

## Updating

```bash
aws ssm start-session --region eu-central-1 --target <instance-id>
cd /opt/ftw-webapp && git pull && cd relay/deploy && docker compose up -d --build
```

Every peer reconnects, which is a few seconds of a freshness stamp falling
behind and no user-visible error. There is nothing to drain. The fleet totals
file appears on first report; no manual data migration is needed.

## What to watch

The relay logs one line every fifteen seconds with aggregate counts — epoch,
rooms, sockets, frames, bytes and today's fleet reports. Deliberately no handles: a log line naming one
is the household identifier this design exists to withhold, and logs are the
least guarded thing in any deployment. The Caddy config strips the request URI
for the same reason, since the join path carries the handle.

Read the detailed fleet totals from the host or an SSM session:

```bash
curl -s http://127.0.0.1:8787/fleet/stats
```

The response says `reports, not unique boxes`. The public
`https://relay.ftw.energy/fleet/stats` route returns 404.

Project stats export is optional. Set both `RELAY_STATS_EXPORT_URL` and
`RELAY_STATS_EXPORT_SECRET` in the deploy `.env` file to send aggregate counts
to `stats.ftw.energy` every five minutes. The body has rooms, sockets, frame and
byte counters, process uptime, and up to fourteen days of the daily fleet
totals above. It has no handles, addresses, ids or routed frames. A failed
export does not stop relay traffic.

Two things worth an alert:

- `/healthz` failing. The container restarts itself, but a loop means something
  real.
- `rooms` at zero while boxes are known to be online. That is either DNS or the
  epoch, and both are visible in the log line.
- `fleet_reports_today` staying at zero for more than a day after a box release
  points at the FTW endpoint, TLS or report validation.

## Rotation

Handles rotate hourly. Both peers derive the handle from the epoch, so both
reconnect — the relay cannot know that this hour's handle and last hour's
belong together, which is the point.

The rotation is spread over five minutes, each room taking a turn at an offset
derived from its own handle. Doing it all at once was an outage: every peer
returned inside the client's three-second jitter and the rate limiter rejected
most of them. It also leaked, since an observer could pair the handles that
vanished with the ones that appeared.

So a modest, continuous trickle of reconnections is normal and healthy. A burst
on the hour is not.
