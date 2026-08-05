# Running the relay

One small instance in eu-central-1, Caddy in front for TLS, the relay behind it
on loopback. That is the whole deployment.

It is deliberately not more. The relay holds nothing — rooms live in memory and
die with their last socket — so a restart costs every peer one reconnection and
loses no data. There is no database to back up and no state to migrate.

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
cryptography. Its own blast radius on purpose: `i-08351b29352efc64e` already
carries `home.sourceful.energy` and buzz-prod, and this should not share a fate
with services being retired.

Security group: 80 and 443 from anywhere (Caddy needs 80 for ACME), 22 from
wherever you administer it. Nothing else — 8787 is bound to loopback and must
stay there, because that is what makes trusting `X-Forwarded-For` safe.

DNS: an A record for `relay.ftw.energy` at the instance's elastic IP, in the
Cloudflare zone. **Grey cloud, not orange.** Proxying WebSockets through
Cloudflare adds a hop that can read frame timing and length, and the whole point
of this service is that the party carrying the traffic learns as little as
possible. Caddy needs to reach Let's Encrypt directly for ACME anyway.

## Bringing it up

```bash
ssh <instance>
git clone https://github.com/srcfl/ftw-webapp && cd ftw-webapp/relay/deploy
docker compose up -d
```

Caddy gets its certificate on first start. Check it took:

```bash
curl -s https://relay.ftw.energy/healthz
```

`ok` means the whole path works: DNS, certificate, proxy, relay.

## Updating

```bash
git pull && docker compose up -d --build
```

Every peer reconnects, which is a few seconds of a freshness stamp falling
behind and no user-visible error. There is nothing to drain and nothing to
migrate.

## What to watch

The relay logs one line every fifteen seconds with aggregate counts — epoch,
rooms, sockets, frames, bytes. Deliberately no handles: a log line naming one
is the household identifier this design exists to withhold, and logs are the
least guarded thing in any deployment. The Caddy config strips the request URI
for the same reason, since the join path carries the handle.

Two things worth an alert:

- `/healthz` failing. The container restarts itself, but a loop means something
  real.
- `rooms` at zero while boxes are known to be online. That is either DNS or the
  epoch, and both are visible in the log line.

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
