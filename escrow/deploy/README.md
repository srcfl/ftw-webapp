# Running the escrow

One small instance, Caddy in front for TLS, the escrow behind it on loopback,
and one file of fixed slots on a volume. That is the whole deployment.

It looks like the relay's deployment because it is the relay's deployment with
a database added. What is not shared is the host, and that is the one decision
here worth arguing about.

## Why not Cloudflare, which is where this started

The claim on the opt-in screen is:

> **Sourceful holds a sealed copy it cannot open, with an opaque id and nothing
> beside it.**

The schema keeps the second half by refusing a fourth column. That is worth
nothing on a store that keeps its own history, because there the timestamps are
written for you, outside the schema's reach, and handed to whoever holds the
account. This service ran on D1 first and the claim was false in operation the
whole time.

Every managed store on the platform was checked before the move, and none of
them can hold the claim. These four rows are the only ones in this file that
were **reasoned from the documented behaviour rather than run**, and they are
from the round when this service was still on D1. `../README.md` has the wider
survey — object storage, Redis, an LSM, LMDB, the dbm family and Postgres — and
every row of that one was measured on 7 August 2026.

| Store | What it keeps, and how that was checked |
|---|---|
| **D1** | Time Travel. Always on, cannot be switched off, thirty days on the paid plan. `wrangler d1 time-travel restore` is in the wrangler this repo pins — confirmed with `npx wrangler d1 time-travel --help` on 4.118.0. Restore at T and at T plus a minute, diff the two, and you have which id was written in that window. |
| **Durable Objects** | The same thirty days, as `getBookmarkForTime` and `onNextSessionRestoreBookmark`, and only on the SQLite backend. The backend without it cannot be chosen: since 9 July 2026 new namespaces must be SQLite-backed. |
| **R2** | Every object carries an `uploaded` date the platform sets and `list` hands back. That is a created-at column with a different name, and it is not optional. |
| **Workers KV** | No point-in-time history, and no compare-and-set either — it is eventually consistent by design. The rollback guard is one atomic statement, so it could not hold at all. A correctness refusal rather than a privacy one. |

So the store is one file this service owns, on a host this service owns.

## Why its own host, and not the relay's

The relay is one small instance already running, and putting this beside it
would save an instance. It would also put an escrow write and a rendezvous join
in the same second on the same host. The escrow id is a stable pseudonym by
construction — the same 32 bytes for the life of a passkey — and the rendezvous
handle rotates hourly precisely so that nothing can follow a household across
the hours. Anyone reading both on one host could tie the one to the other and
undo the rotation.

It is also not the app origin, and for a duller reason: that origin serves
static files with no code in front of them, because a hand-made Worker there
once swallowed `/sw.js` and the app could not open offline.

## The instance

A `t4g.small` is enough. The service parses a small JSON body, does no
cryptography, and touches the disk twice in a device's lifetime.

Security group: 80 and 443 from anywhere (Caddy needs 80 for ACME), 22 from
wherever you administer it. Nothing else — 8788 is bound to loopback and must
stay there.

DNS: an A record for `escrow.ftw.energy` at the instance's elastic IP, in the
Cloudflare zone. **Grey cloud, not orange.** An orange-clouded record puts
Cloudflare's HTTP layer back in front of this, where its analytics and any log
its account holder later switches on would see the time of each request beside
a client address — which is most of what moving off D1 was for. Caddy needs to
reach Let's Encrypt directly for ACME anyway.

## Bringing it up

`bootstrap.sh` is the whole thing — pass it as EC2 user-data on a fresh Amazon
Linux 2023 arm64 instance, or run it by hand. It is idempotent. There is no
schema step: the service applies the schema and the pragmas when it opens the
file, because a step that has to be remembered is a step that gets forgotten.

The host has no SSH and no key pair. Access is through SSM:

```bash
aws ssm start-session --region eu-central-1 --target <instance-id>
```

Check the whole path — DNS, certificate, proxy, service, disk:

```bash
curl -s https://escrow.ftw.energy/healthz
```

## Updating

```bash
aws ssm start-session --region eu-central-1 --target <instance-id>
cd /opt/ftw-webapp && git pull && cd escrow/deploy && docker compose up -d --build
```

A few seconds of refusals, which the app already treats as "try again when you
are back online" and which cost nothing, because nothing in the app depends on
the escrow being reachable. The database volume survives; a rebuild does not
touch it.

### Once, on the host that ran the old configuration

A rebuild takes the log volume out of the compose file. It does not take the
log volume off the disk, and what is in it is a household activity record with
real ids' worth of timing in it — a line per request, with a `ts` and byte
counts that say which operation it was. Removing the mount stops it growing;
this removes it.

```bash
docker volume ls | grep caddy-logs                    # is it still there
docker volume rm ftw-escrow_caddy-logs                # after `compose up -d`, so nothing holds it
docker volume ls | grep caddy-logs                    # nothing
```

The name is the compose project's, so check the first line's output rather than
trusting the second. If `rm` says the volume is in use, a container from the
old configuration is still running: `docker compose up -d` again and retry.

## Where a time could still be kept

The point of this section is that the next person can re-check it. Each row was
checked the way it says, not assumed. **The run below was last done on 7 August
2026**, on Caddy 2.11.4 and Node 26.7.0 — the versions the images resolved to
that day. The rows at the bottom are the ones no run can reach; they are marked.

Four rows were wrong the last time somebody looked, and each was one layer below
the last. Two were in the proxy:

- the site's access log kept one line per request with a `ts`, and the fields
  the filter left behind told the operations apart by size alone — a save read
  769 bytes and answered 13, a read of a copy that was there read 63 and
  answered 707, one that was not read 63 and answered 2;
- the global log block had no filter at all, so a single proxy error wrote the
  client address, the URI and every request header beside the time.

Both are discarded now rather than filtered, because a filter is a list of the
fields somebody thought of and what leaked was the fields nobody thought of. The
wire is padded to one length for the same reason.

The third was in the storage engine's own file. `WITHOUT ROWID` was taken to
mean the file kept no arrival order; it means SQL cannot sort by one. A page
holds its cell pointers in key order and its cell contents in write order, so
sorting one page's cells by descending byte offset handed back the households in
the order they joined.

The fourth was in the fix for the third. A `VACUUM` after every write rebuilt the
file from the rows alone — and to do that it wrote a full, arrival-ordered copy
of the database beside it as a rollback journal, on every save. A household
leaving is a save, so the journal held the leaver's ciphertext while they left:
twenty journal images were seen during one clear, one of them carrying the
leaver's fill byte in a 256-byte run.

**So the store was rebuilt rather than patched a fifth time.** It is one file of
fixed slots, preallocated: a record's place is a function of its id, a write
lands in place, and there is no journal, no compaction and no temporary copy.
`../layout.md` is the format and `../README.md` is the reasoning, including the
survey of everything off the shelf that was measured first.

**The section below is how each row was checked by running it**, which is the
only way any of the four would have been found.

Half of these rows are held by a test in this repository and half by how the
account is set up. They are marked, because the difference is the whole point: a
row that only a person can check is a row that goes stale silently.

**Checked by a test, on every run**

| Where | What it keeps | The check |
|---|---|---|
| The file | Nothing. There is no field for a time and no clock is read. | A test writes, rewrites and clears a copy through the real store, then reads the file back and hunts for an instant in every shape one could be stored in — four-, five-, six- and eight-byte integers either way round, a julian day as a float, an ISO date as text. It first proves the same detector trips on a database that does carry `unixepoch()`, `CURRENT_TIMESTAMP` and `julianday()`. The file is 158 kB of random bytes, so a detector that fires on noise would fire here. |
| Inside the file | No arrival order. The bytes are a function of what is stored, not of when. | A test writes the same forty households in opposite orders and fails unless the two files are byte for byte the same. A second one does it with the production random source and fails unless every record is at the same offset. Both come after a control that reproduces the old recovery on a b-tree written the ordinary way, so a run that finds nothing means something. |
| Beside the file | Nothing at all. | A test writes twice through the real store and fails unless the directory holds exactly one file. There is no journal to create, no second copy to compact into and no lock. |
| Under the file | No arrival order in the block map either. | The file is written in full when it is made rather than having its length declared, so every block is on the disk before any household exists. A test fails if the file is sparse; the run below is what checks the extents on a real filesystem, with a control that shows a declared-length file handing the arrival order straight back. |
| A copy of the file elsewhere on the host | None. | The run below lists every descriptor the process has open while it is busy. This is where SQLite's `etilqs_*` scratch copy of the whole database used to be, on every save, unlinked so that nothing reading a directory could see it. |
| A copy left by a household that leaves | Nothing legible. | A test drives twenty households through the real store, clears one whose copy is filled with a byte no other household uses, and hunts the whole file for it. The wipe of the replaced image is what removes it, and taking that line out fails the test. |
| How many households are in there | Nothing a histogram, a compressor, `strings` or a run-length search can see. | A test builds two files at one capacity, one holding two households and one holding two hundred, and fails unless all three measurements agree within noise. The control takes the random filling out and every one of them screams. A parser that knows the layout still counts them, and `../README.md` says so. |
| The write path's own clock | Nothing on any disk, and it is still audible: two fsyncs on an accepted write and none on a read or a refusal, so a save answers about 2 ms later and holds up whatever is in flight behind it. Anybody probing learns that a write landed, and no id — see `../README.md`, which measures it and prices what is left. | A test holds the read path to no fsync and the write path to exactly two, so this row cannot go stale while the code moves under it. The measurement itself is in `../README.md`, taken through this image behind this Caddyfile over TLS. |
| The escrow process | Nothing, once it is serving. Not a line, not for a request that failed. | A test starts the real server in a real process, runs a whole write-read-clear-refuse cycle over a real socket — including a stranger's write refused with a 403 — and fails if a single byte reached stdout or stderr. A process that cannot start at all still dies with Node's stack trace, which carries nothing about a household. |
| The HTTP layer | Nothing. `node:http` writes no access log. | Same test. |
| The size of a request | Nothing that says which operation. Every request is 1024 bytes and every answer past the length gate is 1024 bytes, the 403 and the 507 included. | A test drives a save, a read, a miss, a lost race and a refused write through the app's own client and measures every byte that went out and came back. It fails unless all of them are one number, and it failed on 63 / 769 / 85 before the padding. |
| What it is deployed on | No managed store, so no history kept for it. | A test walks this directory and fails on a D1, Durable Object, R2 or KV binding, or on a wrangler config file reappearing. |
| The proxy's configuration | No log block that writes anywhere, no admin endpoint. | A weak test, and marked as such where it lives: it reads `Caddyfile` and fails unless every `log` block is exactly `output discard`. A file can be read, not run — the run is the section below. |

**Held by configuration in this repository, so read the file**

| Where | What it keeps | Where to look |
|---|---|---|
| Caddy's access log | Nothing. Discarded, not filtered. | `Caddyfile` |
| Caddy's own diagnostics | Nothing. Discarded, not filtered — this is the block that had no filter and wrote an address on an error. The cost is that a certificate failing to renew is silent; `/healthz` over HTTPS from outside is what catches it. | `Caddyfile` |
| Caddy's admin endpoint | Off. It is on by default on 127.0.0.1:2019, which `network_mode: host` makes the host's loopback. Checked rather than assumed: against a Caddy with it left on, an unauthenticated `GET /config/` returned the running config and one `POST /load` replaced it with one that logged `remote_ip`, `client_ip`, `uri` and every header. | `Caddyfile` |
| Docker | Whatever the containers print, capped at 1 MB and one file each. Both print nothing; the cap is for a Caddyfile so bad that Caddy complains before its own config is in force. | `compose.yml` |
| The number of escrow containers | One. Two would break the rollback guard silently: it rests on the store doing its whole read-decide-write synchronously in one process. | `compose.yml`, and the comment above the service |
| The file's own mtime | One time for the whole store — the last write by anybody. It does not say which id. This is residue, and `../README.md` names it rather than glossing it. | `stat` on the volume |
| The file's length | The capacity, which is what it could hold rather than what it does. One number for the whole service, and it changes only when an operator grows it. | `stat` on the volume |
| Caddy's storage | One timestamp in `/data/caddy/last_clean.json`: when it last swept its certificate storage. It is per instance, not per request, and it moves whether or not anybody used the service. | The `caddy-data` volume |
| Docker's health record | The last five health checks, each with a start, an end and an exit code. That is when the container was asked whether it was alive — the check never touches a household's record. | `docker inspect` |

**Nobody can check from the repository. Check these against the account, and
again after anything changes there**

| Where | What to confirm |
|---|---|
| The filesystem the volume is on | **xfs or ext4, and not a copy-on-write filesystem.** On xfs and ext4 the preallocated file is one extent and no household's write moves a block. On a copy-on-write filesystem — btrfs, ZFS, APFS — an overwrite allocates a fresh block, so the block map is rewritten as households arrive. Measured on APFS, that carried no recoverable order (rank correlation +0.03 and −0.06 over two runs) but it is a property of an allocator rather than of this design, and it should not be relied on. Amazon Linux 2023's root is xfs, which is what this runs on. `df -T /var/lib/docker/volumes` is the whole check. |
| Cloudflare DNS | `escrow.ftw.energy` is grey-clouded, not orange. Orange puts Cloudflare's HTTP layer back in front, where its analytics and any log its account holder switches on see each request's time beside a client address. |
| EBS | No snapshot schedule reaches this volume. `bootstrap.sh` creates none, but an account-wide Data Lifecycle Manager or AWS Backup plan that selects volumes by tag would pick it up without anyone deciding to — and a snapshot at T and another at T plus a day is D1's Time Travel rebuilt by accident. This is the row most likely to go wrong. |
| VPC flow logs | Off for this instance's subnet. They are off unless enabled and `bootstrap.sh` does not enable them, but they are enabled at the VPC in plenty of accounts. |
| CloudWatch | Only the default instance metrics, which are aggregate — CPU, network bytes, no request detail. No agent installed that ships files or logs. |
| journald | Unit starts and stops for `ftw-escrow.service` and for Docker itself, with times. That is when the host came up, not when a household wrote — but confirm nothing else on the instance ships the journal anywhere. |
| The page cache and swap | Recent pages sit in memory in the order they were touched, on this host as on any other, and swap can put them on a disk. Nothing here configures that away. Confirm the instance has no swap file enabled — Amazon Linux 2023 has none by default — and treat memory on a compromised host as compromised. |

**The property all of this adds up to, in one sentence.** The service keeps no
record of when anything was written, and none can be recovered afterwards.
Someone with the host could of course copy the file every hour and diff the
copies — but that is a thing they would have to decide to do in advance and leave
a trace doing, which is exactly what point-in-time history took away.

That sentence has been false four times, and the fourth time was the fix for the
third. Two fewer than the count in `../README.md`, and deliberately so: neither
of the other two is something this host keeps. The fifth was
`docs/architecture.md`, which went on describing the store these four were found
in after it had been replaced — a layer like any other, and the only one where
nothing goes red when it rots. The sixth is the clock: an accepted write pays two
fsyncs and a read pays none, so a save takes about 2 ms longer to answer and
anybody probing can tell one landed. It writes nothing anywhere, so nothing about
it can be recovered afterwards and the sentence above survives it — which is why
the count here does not move and why `../README.md` prices it under "what it
still knows" instead. So this sentence is worth exactly what the last run of the
section below is worth, and that is why the run has a date on it.

Re-check the table after any platform change: a proxy added in front, a managed
database swapped in, a log driver, a snapshot schedule, an agent installed on the
host, a new image tag for Caddy or Node, a volume moved to another filesystem.
Any one of them can make the sentence on the opt-in screen false without touching
a line of the store.

## Checking it by running it

Twenty minutes, on any machine with Docker. Nothing here needs the real host,
DNS or a certificate — what is being checked is what the proxy and the runtime
write down, and they write the same things on a laptop.

Two lines change to keep the rig local: the site address, so Caddy does not go
to Let's Encrypt, and the build context, because the compose file is being run
from somewhere else. Change nothing else — the log blocks are the subject.

```bash
rig=$(mktemp -d) && cd "$rig"
repo=~/repositories/ftw-webapp        # wherever this checkout is

sed -e "s|context: ../..|context: $repo|" -e 's|^name: ftw-escrow$|name: escrow-rig|' \
  "$repo/escrow/deploy/compose.yml" > compose.yml
sed 's|^escrow\.ftw\.energy {|http://:8080 {|' "$repo/escrow/deploy/Caddyfile" > Caddyfile

# Prove the rig is the repository's files and not a copy that drifted.
diff <(sed 's|^http://:8080 {|escrow.ftw.energy {|' Caddyfile) "$repo/escrow/deploy/Caddyfile"

docker compose up -d --build
```

Then put a household's whole life through it — a save, a read that finds a copy,
a read that finds none, a clear — plus a stranger who has the id and a key of
their own, which is the refusal a service is most tempted to be helpful about.

```bash
cat > wire.mjs <<'EOF'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { writeMessage } from '/repo/escrow/src/store.ts'
const pad = (o, n) => { const e = JSON.stringify({ ...o, pad: '' })
                        return JSON.stringify({ ...o, pad: 'A'.repeat(n - e.length) }) }
const id = createHash('sha256').update('wire').digest().toString('base64url')
const miss = createHash('sha256').update('nobody').digest().toString('base64url')
const key = generateKeyPairSync('ed25519')
const pubOf = (k) => Buffer.from(k.export({ format: 'jwk' }).x, 'base64url').toString('base64url')
const save = (v, fill, len = 512, k = key) => {
  const blob = new Uint8Array(len).fill(fill)
  return { op: 'put', id, version: v, blob: Buffer.from(blob).toString('base64'),
           pub: pubOf(k.publicKey),
           sig: sign(null, writeMessage(id, v, blob), k.privateKey).toString('base64url') }
}
const call = async (what, o) => {
  const body = pad(o, 1024)
  const r = await fetch('http://127.0.0.1:8080/e',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  const text = await r.text()
  console.log(`${what.padEnd(9)} sent ${Buffer.byteLength(body)}, status ${r.status}, back ${Buffer.byteLength(text)}`)
}
await call('put', save(1, 3))
await call('get hit', { op: 'get', id })
await call('get miss', { op: 'get', id: miss })
await call('clear', save(2, 0, 0))
await call('stranger', save(3, 9, 512, generateKeyPairSync('ed25519')))
EOF
docker compose exec -T escrow node - < wire.mjs        # inside, so /repo is there
curl -s -o /dev/null http://127.0.0.1:8080/healthz
```

It should print one number for what went out and one for what came back,
whichever operation it was and whoever asked:

```
put       sent 1024, status 200, back 1024
get hit   sent 1024, status 200, back 1024
get miss  sent 1024, status 404, back 1024
clear     sent 1024, status 200, back 1024
stranger  sent 1024, status 403, back 1024
```

Now read what landed. Every one of these should come back empty, and each
answers a different way this went wrong before:

```bash
# 1. The proxy's own files. There should be no log directory at all — not an
#    empty log, no directory. This is where two of the four leaks were found.
docker compose exec caddy sh -c 'ls -la /var/log/caddy'      # No such file or directory

# 2. What Docker kept from each container's stdout and stderr. Zero bytes.
for s in caddy escrow; do printf '%s: ' $s; docker compose logs --no-log-prefix $s | wc -c; done

# 3. The running config, read back out of the container rather than off the
#    file — this is what Caddy actually has, adapter and all.
docker compose exec caddy grep -o '"logging".*' /config/caddy/autosave.json
#    → both writers are {"output":"discard"} and neither names a file.

# 4. The admin endpoint, which is off. Connection refused, not a 200.
curl -s -m 3 http://127.0.0.1:2019/config/ ; echo "exit $?"    # exit 7

# 5. Everything else in the proxy's volumes. instance.uuid, last_clean.json
#    and autosave.json, and nothing per request.
docker compose exec caddy find /data /config -type f

# 6. The escrow's own open files, while it is busy. This is where the old
#    store's scratch copy of the whole database lived, unlinked so that no
#    directory listing could ever find it.
docker compose exec escrow sh -c 'ls -l /proc/1/fd'
#    → one regular file, a socket, and Node's own pipes and eventfds. Nothing
#      marked "(deleted)", which is what an unlinked temporary copy looks like.

# 7. The volume. One file, and one modification time for the whole service.
docker compose exec escrow sh -c 'ls -la /srv/escrow/data'

docker compose down -v && cd - && rm -rf "$rig"
```

What each of those printed on 7 August 2026 is in the table above. If any of them
prints a request line, a byte count or an address, the sentence on the opt-in
screen is false again and the fix is to take the log away rather than to filter
it.

### The block map, and why the file is written rather than declared

Step 6 used to be the subtle one. It is now this, because it is the layer below
the fix and the last four failures were all one layer below the last fix.

A preallocated file whose length is merely declared — `ftruncate` — has holes in
it, and the filesystem hands out a block the first time each one is written. So
the physical order of the blocks would be the order the households arrived in:
the same defect the whole rebuild is about, one level further down, invisible to
every test that reads the file's contents.

Measured on 7 August 2026 inside a privileged container, on freshly made xfs and
ext4 loopback filesystems, with the control first:

```
CONTROL: the same slot file with its length declared, 40 buckets written shuffled
  /mnt/xfs/sparse.slots: 38 extents found
  buckets by ascending physical block: [27,21,7,20,17,4,18,25,32,11,39,30]
  the order they were written        : [27,21,7,20,17,4,18,25,32,11,39,30]

THE REAL ONE: every byte written when the file is made, 128 buckets, shuffled
  /mnt/xfs/escrow.slots: 1 extent found
  /mnt/ext4/escrow.slots: 1 extent found
```

The control hands back the arrival order from the extent map alone. The real
file is one extent, laid down before any household existed, and no household's
write moves a byte of it.

To repeat it:

```bash
docker run --rm --privileged -v ~/repositories/ftw-webapp:/repo:ro node:26 bash -c '
  apt-get update -qq && apt-get install -y -qq xfsprogs e2fsprogs
  dd if=/dev/zero of=/img bs=1M count=400 status=none && mkfs.xfs -q /img
  mkdir -p /mnt/xfs && mount -o loop /img /mnt/xfs
  ESCROW_DB=/mnt/xfs/escrow.slots node /repo/escrow/src/main.ts & sleep 2
  # …a few saves through the wire script above…
  sync && filefrag -v /mnt/xfs/escrow.slots'
```

On the real host the same question is one line, and it is the row in the third
table above: `df -T` on the volume must say `xfs` or `ext4`, and `filefrag` on
the file must say one extent.

## What to watch, with nothing to read

There is no log anywhere on this host, on purpose, and that is a real cost as
well as the point. Three things are worth an alert:

- **`https://escrow.ftw.energy/healthz` failing, from outside.** Over HTTPS and
  from off the host, so one check covers the whole path: DNS, the certificate,
  Caddy, the process and the disk. The container restarts itself, but a loop
  means something real.

  It answers two questions, and the second is easy to miss. `untidy` rather than
  `ok` means every save is still landing correctly and the copy each save
  replaces has stopped being wiped — so the service looks perfectly healthy to
  every household while its file keeps copies people have taken away. **Treat it
  as an incident, not a warning**, because nothing else anywhere on this host
  will ever mention it. The cause is almost always the disk. A restart clears the
  flag without fixing anything, so check the disk first.
- **A 507 to anybody.** That is a bucket at its ceiling, and it means a household
  could not save at all. It should never happen below the capacity the file was
  made for — measured at a hundred thousand households in 3125 buckets of 64,
  no bucket overflowed and the fullest held under half — so one is a signal that
  the file is past its size. There is no counter to watch, because there is no
  log; the way to see it coming is the row count below.
- **The number of households approaching the capacity.** Not a failure, a
  deadline, and unlike the old one it is about space rather than about time: a
  save costs two fsyncs and about 8 ms whatever the file holds, measured at 8.1
  ms for a capacity of four thousand and 8.0 ms at a hundred thousand, with reads
  at 0.15 ms in both. What runs out is slots. The file is `stat` and the capacity
  is its length divided by 78 912 times 32; growing it is:

  ```bash
  docker compose stop escrow
  docker compose run --rm --entrypoint node escrow \
    src/grow.ts /srv/escrow/data/escrow.slots 100000
  docker compose up -d escrow
  ```

  It rewrites the whole file through a temporary one and renames at the end, so a
  machine that dies during it leaves the old file exactly as it was. It refuses to
  shrink onto a capacity that would not hold what is already there. What it
  reveals is a new modification time and a new length, both of which are one
  number for the whole service, and no order at all: the new layout is a function
  of the set of records, so it is the same file the service would have written.

  Size the volume at the file's length plus a little. It does **not** need twice
  the data any more: that was for the rewrite's rollback journal, and there is no
  rewrite and no journal.

When one of them fires, the usual first move is to read the log, and there is
none. What to do instead:

- **A certificate that stopped renewing** is silent now, which is what discarding
  Caddy's own diagnostics costs. Look at the certificate rather than at a log. It
  is in the `caddy-data` volume, and the image has no `openssl`, so read it out to
  the host's:

  ```bash
  docker compose exec caddy find /data/caddy/certificates -name '*.crt'
  docker compose exec caddy cat <that path> | openssl x509 -noout -dates -subject
  ```
- **A Caddyfile that will not load** does say so, on stdout, before its own config
  is in force — that is what the 1 MB cap on the caddy container is for.
  `docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile` answers
  the same question without restarting anything.
- **The escrow refusing everything** is a disk that has gone read-only, or a file
  that is not there. It answers 500 and says nothing, by design; `/healthz` is what
  tells you, and `docker compose exec escrow ls -la /srv/escrow/data` is where to
  look next.

Turning logging back on to debug something is the one change that makes the claim
on the opt-in screen false. If it has to happen, it happens while nothing is
serving households, and it comes back off in the same session.
