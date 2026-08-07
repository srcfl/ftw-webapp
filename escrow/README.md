# The sealed escrow

Holds one sealed copy of a household's home, so a phone with nothing on it can
come back with a passkey alone. It cannot open what it holds, and it knows
nothing else about the household.

```
phone ──https──▶ ┌────────────┐
                 │   escrow   │   id   ver   write key   blob
                 │  no keys   │  32 B  4 B      32 B     512 B
                 │  no names  │
                 └────────────┘
```

The claim, in the words the app puts on screen:

> **Sourceful holds a sealed copy it cannot open, with an opaque id and nothing
> beside it.**

## Losing this database costs a QR scan

That is the whole disaster plan, and it is what makes this safe to operate.
Nothing depends on the escrow. A household that loses its copy is back to where
every household is today: scan the code on the box. There is no backup to
restore, no failover to rehearse and no data to reconcile — so restore it from
nothing if you like, or don't.

## What it does

Two operations, one path, one method, one length:

```
POST https://escrow.ftw.energy/e
{ "op": "get", "id": "<43 chars>",                                          "pad": "AAA…" }
{ "op": "put", "id": "<43 chars>", "version": 3, "blob": "…", "pub": "…", "sig": "…", "pad": "AAA…" }
{ "op": "put", "id": "<43 chars>", "version": 4, "blob": "",  "pub": "…", "sig": "…", "pad": "AAA…" }  ← clears it
```

| Answer | Meaning |
|---|---|
| 200 | The copy, with its version — or, for a put, that it landed |
| 404 | Nothing under that id |
| 409 | The version was not the immediate successor. Read and try again |
| 403 | Signed by nobody, or by a key that is not the one pinned under this id |
| 507 | This id's bucket is full. Rare, and the file needs growing |
| 400 | Not a legal request. Nothing about which part is wrong |

**Reading is the id alone. Writing is not.** A fresh install has a passkey and
nothing else, so a read has to be answerable with the id — that is the whole
feature. A write carries an Ed25519 key and a signature; the first write pins
the key and no later write with a different one is taken. Both the id and the
key come out of the same passkey ceremony, so it costs the household nothing.

**The id is never in a URL.** A URL is the part of a request every layer writes
down — proxy logs, sampled dashboards, anything an operator later switches on —
so an id in a path would be an id in somebody's log beside a timestamp, and
"nothing beside it" would be false in operation while the store stayed clean.

A `POST` is also never cached, which matters more than it looks: a shared cache
keyed on a URL is one misconfiguration away from handing one household's
ciphertext to another.

**Every request is 1024 bytes and every answer past that gate is 1024 bytes.**
That was learned rather than designed. The proxy in front of this kept one line
per request with the URI, the headers and both address fields deleted — and what
the filter left behind still told the three operations apart by size alone: a
save read 769 bytes and answered 13, a read of a copy that was there read 63 and
answered 707, and one that was not read 63 and answered 2. Beside a stable
pseudonym and a timestamp, that is a household's activity record.

The logs are gone now, which fixed the instance. The padding fixes the class: a
byte count is not a field, so no filter can delete it. It costs about a kilobyte
twice in a device's life. The same argument padded the blob to 512 bytes, and
pads lane 0 in the app.

## What it cannot do, and how you can check

Read `src/`. Three small files and their tests, and they are meant to be read:
the wire and the refusals in `escrow.ts`, the file format and the two guards in
`store.ts`, a hundred lines of server in `main.ts`. `layout.md` is the store
without any TypeScript in it.

| Claim | Where to look |
|---|---|
| No keys, no decryption | Nothing here decrypts anything or holds a secret key. It hashes, and it verifies a signature — both need only public inputs |
| Nothing beside the ciphertext | `layout.md` — four fields in a fixed slot, and a test holds the file to the numbers in it |
| No created-at, no updated-at | Same file. There is no field to write one to, and a test reads the whole file back looking for an instant in every shape one could be stored in |
| No history kept for it either | It runs on its own file, not a managed store — see below |
| No arrival order | The bytes are a function of what is stored. A test writes the same households in opposite orders and fails unless the two files are the same bytes |
| No arrival order below the file either | The file is preallocated, so it is one extent on the filesystems this runs on and no block is handed out when a household arrives. Measured, with a control — see below |
| No enumeration | `EscrowStore` has two verbs, and neither returns more than one id |
| No deletion | Deliberate — see below. There is no verb for it |
| No id in any URL | One path, `/e`, the same for every household |
| No request log in the service | It writes nothing at all — a test starts it, drives every refusal there is through it and proves it stayed quiet |
| No request log in the proxy | `deploy/Caddyfile` discards both of Caddy's logs rather than filtering them, and `deploy/README.md` has the run that reads the disk afterwards |
| No size that says which operation | Every request is 1024 bytes and every answer past the length gate is 1024 bytes, the new 403 included. A test drives a save, a read, a miss, a lost race and a refused write through the app's own client and measures what went out |
| No time that says which operation | **It has one, and it is the one thing on this table that is left open rather than closed.** A read and a refused write touch no disk; an accepted write pays two fsyncs, so it takes about 2 ms longer and holds up every request in flight behind it. What that hands an outsider is a count of writes over time, with no id and no household in it — measured under "What a request costs", named under "what it still knows" |
| No copy of the database anywhere else | There is nothing to copy it for: no journal, no compaction, no temporary file. `deploy/README.md` has the run that lists every file the process has open while it is busy |
| Nothing legible left by a household that leaves | A test drives twenty households through the real store, clears one whose copy is filled with a byte no other household uses, and hunts the file for it |
| Nothing that counts the households | Every slot is random bytes from the moment the file is made, so a histogram, a compressor, `strings` and a search for repeated bytes cannot tell a file holding two from one holding two hundred. A parser that knows the layout can — see what it still knows |
| A stranger with the id cannot overwrite a copy | The write key is pinned on the first write and compared in constant time. A test takes the id off the wire, signs with a fresh key and fails unless the copy is untouched |
| One origin, never a wildcard | `DEFAULT_ORIGIN` in `escrow.ts` |

## Why it is not on anything off the shelf

This is the question worth asking about a hand-written store, and the answer has
to be earned. Every candidate below was **run**, on 7 August 2026, and the
question put to each was the same one: after the same households are written in
two opposite orders, is what lands on the disk the same? Plus the two cheaper
questions — is there a per-record time, and is there a log beside the data.

| Store | What it did |
|---|---|
| **A file per household** (also the shape of one object per household) | Six files written a few milliseconds apart: sorting by `mtime` gave back the arrival order exactly, and so did sorting by inode number. A file each is a created-at each |
| **S3 and friends**, measured against MinIO | `ListObjectsV2` returned a `LastModified` per object to the millisecond, in arrival order, with nothing asked for and nothing to switch off. It is a created-at column under another name, and it is in the API contract rather than in a setting |
| **Redis**, RDB and AOF both | `OBJECT IDLETIME` answered 8, 6, 5, 4, 3, 1 seconds for six keys written a second apart — a per-household last-touched time, live, from RAM, with no schema anywhere near it. And the append-only file is exactly that: every write in arrival order, in plain text. Turning AOF off leaves `OBJECT IDLETIME` |
| **LevelDB**, which is RocksDB's shape | The write-ahead log held all forty ids in arrival order, verbatim, before any compaction. A compaction did clear a leaver's value, so the residue is fine and the log is not |
| **LMDB** | The two files differed. And a household that cleared its copy left the 512 bytes it had taken away still legible in the file afterwards, because a copy-on-write b-tree frees a page rather than wiping it |
| **The dbm family**, measured against ndbm | The two files differed. Five different arrival orders of the same twelve households gave five different file digests, and the same order gave the same digest every time — so the file is a function of the arrival order and therefore carries it |
| **PostgreSQL** | Every row has `xmin`, a system column holding the transaction that wrote it: `SELECT xmin, id FROM escrow ORDER BY xmin` handed back the arrival order with no schema column at all. `ctid` gives the physical position, and there is a 16 MB write-ahead log |
| **SQLite**, which is what this was | A `WITHOUT ROWID` page keeps its cell pointers in key order and its cell contents in write order, so sorting a page's cells by descending byte offset gave the households back in the order they joined. The fix for that — a `VACUUM` after every write — wrote a full arrival-ordered copy of the database beside it as a rollback journal on every save, and a household leaving put its own ciphertext in that journal on the way out |

Two of these were reasoned rather than run, and are marked as such: **Cloudflare
D1, Durable Objects and R2** are in `deploy/README.md` with what was checked
about each, from the round when this service still ran on D1; and **Berkeley DB,
tkrzw and the rest of the dbm family** were not run one by one, because ndbm and
LMDB are the two shapes they share and both failed.

The pattern across all of them: the arrival order is not a feature any of these
chose to keep. It is what a tree, a log or a file-per-key **is**. Chasing it out
of one of them a layer at a time is fighting the tool, which is what the last
four rounds of this were.

## Why a file of fixed slots

`layout.md` is the format. What matters is the property: **a record's place is a
function of its id and of nothing else**, every slot is the same size, every one
of them is written with random bytes when the file is made, and a write lands in
place. There is no arrival order to remove because there is no arrival order.

Four things it costs, and none of them is hidden.

- **Space.** About 2.5 kB of file per household of capacity, against 512 bytes of
  data. Half of that is the second copy of each bucket, which is what buys
  atomicity with no journal; the other half is the empty slots, which is what
  buys collision resolution with no probing. A file for four thousand households
  is 10 MB and one for a hundred thousand is 247 MB.
- **A capacity.** The file is preallocated, so its length is what it can hold. A
  bucket that is full refuses a household it has never seen, with a 507.
  Measured at the size the file is made for: over a hundred thousand households
  dealt into 3125 buckets of 64, no bucket overflowed and the fullest held under
  half. `src/grow.ts` moves the ceiling, with the service stopped.
- **One process, and never two.** The rollback guard used to rest on SQLite's
  atomicity for a single statement. It rests now on the store doing its whole
  read-decide-write synchronously, which settles two devices racing inside one
  process and settles nothing between two. `deploy/compose.yml` says so where
  somebody would go to scale it.
- **Two fsyncs a save.** One for the new copy and one for wiping the old. On the
  machine this was measured on that is 3.8 ms each, so a save is about 8 ms —
  and, unlike the rewrite it replaces, **it does not grow with the number of
  households**: 8.1 ms at a capacity of four thousand and 8.0 ms at a hundred
  thousand, with a read at 0.15 ms in both. The 500 ms budget and the hundred
  thousand household ceiling that came with the `VACUUM` are both gone.

What it buys, beside the order: no journal, no compaction, no background work,
no temporary copy of the database in the host's temp directory, and no second
file of any kind. The whole store is one file, and `ls` on the volume shows one
file.

## What is below the file, because that is where the last four were

Every one of the four failures was one layer below where the previous fix
looked. So the layer below this one was measured too, before shipping it, rather
than after somebody found it.

**Filesystem allocation.** A file whose length is merely declared is a file whose
blocks are handed out by the filesystem the first time each one is written — so
the block order would be the arrival order, exactly the defect that started this,
one level further down. That is why the file is written in full when it is made
rather than with `ftruncate`, and it is measured with a control:

```
CONTROL: the same slot file with its length declared, 40 buckets written shuffled
  /mnt/xfs/sparse.slots: 38 extents found
  buckets by ascending physical block: [27,21,7,20,17,4,18,25,32,11,39,30]
  the order they were written        : [27,21,7,20,17,4,18,25,32,11,39,30]

THE REAL ONE: every byte written at creation
  /mnt/xfs/escrow.slots: 1 extent found
```

One extent, on xfs and on ext4 both — the file is one run of blocks laid down
before any household existed, and no household's write moves a byte of it. On
APFS, which is copy-on-write, the blocks do move: 126 of 128 buckets were
somewhere else after their household wrote. Even there the device order carried
no arrival order that could be found — rank correlation +0.03 writing as fast as
possible and −0.06 with a pause between households — but that is two runs on a
laptop and it is not the deployment. **The deployment is xfs on EBS, and the
one-extent result is the one that matters.** `deploy/README.md` has the run.

**The container's writable layer.** The file is on a volume, and the process
opens exactly one regular file. Listing every descriptor while it was serving:
the file, a socket, and Node's own pipes. Nothing unlinked, which is where
SQLite's scratch copy of the whole database used to be on every save.

**The page cache and swap** hold recent pages in memory, in the order they were
touched, on this host as on any other. That is not persistence and there is
nothing here to configure about it — but it is named rather than left out, and
`deploy/README.md` lists it with what to confirm on the instance.

**And below all of those is the clock**, which puts nothing on a disk at all and
is the one layer still open. It is the sixth, it is measured under "What a
request costs", and it is priced under "what it still knows".

## The id, and what it costs

The id is 32 bytes of HKDF output over the passkey's PRF secret, under its own
`info` string. Its siblings — same secret, different `info` — are the key that
seals the blob and the key that signs a write. None is a function of another, so
the id the service holds says nothing about either key, and a fresh device
derives all three from the passkey alone with one prompt.

Three costs, and the app's opt-in screen names them rather than burying them
here:

- **The id is permanent.** It is a function of the credential and a fixed salt.
  Rotating it means a new passkey, a new copy, a write under the new id and a
  clear of the old record.
- **It is a stable pseudonym.** The service sees the same 32 bytes every time,
  beside whatever the network reveals. The mitigation is the shape of the
  traffic and not a policy: this is touched twice in a device's life, once on a
  write and once on a recovery. Two requests, not a stream.
- **It is a target for reading.** Knowing an id yields ciphertext and the fact
  that the id exists. It no longer yields the ability to overwrite. The property
  that makes guessing pointless is the size of the id space and the absence of
  any listing. A hit and a miss are the same number of bytes and now also the
  same work — see "What a request costs" below for what that does and does not
  claim.

## The two guards

### The version, against an old copy coming back

`version` travels outside the seal, because the service must read it with no
key. It is accepted **if and only if** it is the immediate successor: a first
write is version 1 against a record that is not there, and everything after is
exactly one more than what is stored. Strictly the successor, never merely
greater — a gap means a write was lost or forged, and accepting one lets anyone
who watched a number go by push a household past a copy they are holding.

It used to be one SQL statement, so SQLite's atomicity settled two devices
writing at once. It is now the store's whole read-decide-write running
synchronously in one process, which settles the same thing. A test fires eight
writes at one version at once and fails unless exactly one lands.

The version is also bound **into** the seal as additional data, which is the half
the service cannot enforce for itself. Without it, whoever holds the record could
pair an old blob with a fresh version number and hand a household back a home it
had removed. With it, that swap simply fails to decrypt on the phone.

### The write key, against a stranger with the id

This file used to say that knowing an id was the whole authorisation, and it
was: anyone who learned one could write version+1 of anything and destroy a
household's spare copy. A write now carries an Ed25519 public key and a
signature over

```
ftw-escrow:v1:<id>:<version>:<sha256 of the blob, hex>
```

The first write pins the key. Every later write must present the same one,
compared in constant time, and a signature that checks out under it. The key is
derived from the passkey the same way the sealing key is, so a household pays
nothing for it and a fresh device has it after the same one prompt.

What is left, named rather than glossed: **an id nobody has written yet belongs
to whoever writes it first.** Learning an id takes a passkey ceremony on that
household's own credential, and the app's first write follows that ceremony
inside a second, so the window is that gap rather than a policy. Nothing here is
ever evicted, which is what stops a pin lapsing and reopening the window later —
that lesson came from an earlier project, which had to learn it by garbage
collecting the wrong thing.

### Why there is no delete

A delete looks like the obvious way for a household to leave, and it quietly
undoes both guards at once. Versions count from 1 against a record that is not
there, so a deleted id accepts a first write again — and an earlier blob really
was sealed under version 1, so whoever kept one could write it straight back. It
would also drop the pinned key, so the id would be there for whoever claimed it
next. A test caught the first of those after the design had already been agreed;
it is in `tests/escrow-e2e.test.ts` under "cannot be resurrected by clearing the
copy first", and the second is in `escrow/src/escrow.test.ts` under "pins the key
on the first write and keeps it through everything after".

So leaving is a write of zero bytes at the successor version. The count carries
on and both guards hold.

## What it still knows

Honesty about the residue, in the spirit of `docs/architecture.md`:

- **An id that has ever been used keeps a record**, even after the household
  clears its copy: the id, a version number and a public key, in a slot that
  looks exactly like an empty one to anything that does not know the layout. So
  somebody who does know it can say that some passkey once used the escrow and
  roughly how many times it wrote. It cannot say whose, when, or what. That is
  the price of the two guards and it was paid deliberately.
- **The number of households, to somebody who has the file and knows this
  layout.** Every slot is random bytes, so a byte histogram, a compressor,
  `strings` and a search for repeated bytes all come back the same whether the
  file holds two households or two hundred — a test measures all three, with a
  control that screams when the random filling is taken out. But the digest on
  each record is checkable by anybody, so a parser counts them. This is better
  than the store it replaces, where the row count was one query, and it is not a
  secret. **It rests on the blob being ciphertext**, which the app guarantees and
  the service cannot check: a household that stored 512 bytes of one value would
  be countable by exactly the tools above.
- **That a write landed, and about when, to anybody probing while it happens.**
  An accepted write pays two fsyncs and a read pays none, so a write costs
  3.10 ms against a read's 1.07 — and because the whole read-decide-write runs
  synchronously in one process, it holds up every request already in flight:
  6.29 ms against 4.13 for a get fired alongside one. What that yields is a count
  of writes over time and nothing beside it. Not an id, not a bucket, not which
  kind of write, not a household, not an order — the four attempts to get any of
  those out of it are measured above and all four came back a coin. It has to be
  taken live, by somebody sending requests through the whole of the run, and it
  leaves nothing on any disk to read afterwards. What it adds up to is aggregate
  information about **Sourceful's own service** — how often anybody saves — and
  over weeks that is a growth rate we do not publish. Two things make it cheaper
  to take than it sounds: anybody can make an accepted write of their own, so the
  probe calibrates itself, and there is no log and no rate limit, so taking it
  leaves no trace. **It is left open deliberately.** Closing it means every
  request pays two fsyncs — a read goes from 1.07 ms to 3.10 ms and the disk
  takes every get as well as every put — in exchange for a channel that names
  nobody. That trade is only good while it names nobody, which is why the four
  attempts above are written down with what each one measured, and why finding a
  fifth is a reason to close it rather than to argue with it.
- **The capacity.** The file's length says what it could hold, always, and a
  resize changes it. That is one number for the whole service.
- **No count of every write ever made, which the old store did keep.** SQLite
  puts a change counter in its file header and bumps it once per transaction, so
  two copies of the file taken at different times differed by how many saves had
  happened in between. That was named here as residue that could not be removed
  without lying to the engine about its own cache. There is no engine now and no
  header at all, so there is nothing to bump: the nearest thing left is each
  household's own version number, which is in their record because the rollback
  guard needs it.
- **A diff of two copies of the file, to somebody who took both.** One save
  rewrites its whole bucket — measured at 78 597 changed bytes out of 78 912,
  the rest coinciding by chance in the redrawn noise — so a diff says which
  bucket was written, and a parser then says which record's version moved. That
  is the same thing an hourly copy always bought and it is named in the closing
  paragraph below. What changed is the price: it now takes two copies of the
  file rather than one restore command against a managed database, or one look
  at a proxy log.
- **The file's own modification time.** One time for the whole store — the last
  write by anybody — and it says nothing about which id. This is the residue that
  replaced D1's thirty days of per-row history, and it is the reason the store had
  to be a plain file rather than a managed one or a file per household.
- **Old ciphertext, for as long as one write takes.** A write puts the new copy
  in the bucket's other image and then wipes the one it replaced. Between those
  two steps the old copy is still there. That is milliseconds, and it is the
  window a machine dying mid-write leaves open until the next write to that
  bucket. Both the wipe and the window are tested.
  - **What is no longer on this list**, and is the reason for the rebuild: there
    is no journal, no compaction and no temporary copy, so a household leaving no
    longer writes their own ciphertext into a second file on the way out.
- **Client IP addresses**, for as long as a request is open. They are not written
  down by the service or by the proxy, and TLS termination sees them.
- **Timing.** Two requests in a device's life is a thin channel, and it is the one
  that survives. Padding makes every request and every answer the same size, so a
  watcher on the network learns that a household touched the escrow and not which
  of the operations it did — but it still learns when. That is the watcher on the
  wire; the bullet above is the same clock read from the other end, by somebody
  with no vantage on the network at all. What a reply used to say by how long it
  took is **What a request costs**, below.
- **The status code, to whoever terminates TLS.** That is Caddy, which writes
  nothing anywhere. It is the last thing that tells a hit from a miss, and it now
  also tells a refused write from an accepted one.

What is **not** on that list, and is the point of the whole store choice: there
is no record of when a copy was written, or of which household wrote before
which, and neither can be recovered afterwards.

That sentence, and the shorter one on the opt-in screen it exists to serve, was
false six times before it was true, each time one layer below where it had last
been checked. On D1, whose Time Travel kept the write times the
schema refused. Then in the proxy, whose two logs kept a line per request with a
timestamp and byte counts that named the operation. Then in the storage engine's
own file, where the cell layout kept the arrival order that `WITHOUT ROWID` was
supposed to have removed. Then in the fix for that, where a `VACUUM` after every
write wrote an arrival-ordered copy of the whole database beside it as a rollback
journal — and a household leaving is a write, so the journal held the leaver's
ciphertext while they left.

The fifth was not on a disk. This file was rewritten around the store that
replaced all of them, and `docs/architecture.md` — where somebody goes to learn
the design — went on describing the store that had just been replaced, with the
third and fourth failures written down as the guarantee that made the claim
safe. A document is a layer like any other, and it is the one layer where
nothing goes red when it rots. `tests/escrow-claims.test.ts` reads it now, and
reads the count in this paragraph against the count in the other two places the
story is told.

**The sixth is below the disk, and it is the first one that puts nothing on
one.** An accepted write pays two fsyncs; a get and a refused write pay none. So
a save takes about 2 ms longer than a read, and because the whole
read-decide-write runs synchronously in one process, everything already in
flight waits for it. Anybody who can send a request can therefore tell that a
write landed and about when — with no id, no household and no vantage on the
network. The long sentence above survives that: nothing is recorded and nothing
can be recovered afterwards. The short one on the screen does not, quite.
"Nothing beside it" is not the whole truth for somebody standing at the door
with a stopwatch, who comes away with a count of writes over time. It is written
down rather than closed, and the price of that decision is in "what it still
knows" with the numbers: the five before it each yielded a fact about a
household, this one yields a fact about Sourceful, and closing it would put two
fsyncs on every read for a channel that names nobody.

The pattern is worth more than any of the six: four were found by reading what a
real run put on a real disk, the fifth by reading the document beside the code it
describes, and the sixth by timing a real deployment through its own proxy. None
was visible in the schema, the code or the configuration. Check the layer below
the one that looks settled. That is why the filesystem's block map was measured
before this shipped rather than after — and the clock straight after it.

Someone with the host could still copy the file every hour and diff the copies.
That is something they would have to decide to do in advance and leave a trace
doing. Point-in-time history, a proxy log and a rollback journal are what took
that decision away.

## What a request costs

Padding fixed the size of an answer. It did nothing about the clock, and for a
while the clock was the loudest thing here.

Reading a bucket used to stop the moment an image failed its digest, and an
empty bucket is exactly a bucket whose two images both fail. So an empty bucket
cost two hashes and an occupied one cost those plus a hundred and twenty-eight
more. Measured, in process, on reads that all **missed**:

| what the bucket held | p10 | p50 | p90 |
| --- | --- | --- | --- |
| nobody | 30.8 us | 32.3 us | 44.3 us |
| one household | 113.6 us | 118.7 us | 215.8 us |
| sixty-four households | 122.1 us | 127.8 us | 259.1 us |

Nothing there is a secret about any one household — it is a household *counter*.
An id's bucket is a function of the id, so anyone can pick an id for each bucket
in turn, time a read of each, and get the shape of the population from a service
that has no listing verb. Do it twice a week and the difference is arrivals.

A put leaked the same fact to anyone who could send one, because it parsed the
bucket before it checked anything: 128 us against 224 us. And the put had a
second leak of its own — the pinned-key check ran before the signature check, so
a wrong key against an id somebody holds skipped an Ed25519 verification that
the same wrong key against an unheld id had to pay for, 151 us against 224 us.
That one is an existence oracle for a single id rather than a counter.

So a bucket is now parsed whole every time: both images, all 128 slots, the same
digests, the same loop, the same allocations. The search compares every slot and
each comparison takes a fixed number of steps rather than stopping at the first
differing byte. Both authorisation checks always run and the answer is decided
after them. And the handler base64-encodes 512 bytes whether or not it has 512
bytes to send, because encoding only on a hit is a per-id oracle that padding
cannot cover.

After, same machine, same method, order shuffled every round, over a loopback
socket through the server that actually serves:

| what the bucket held | p10 | p50 | p90 |
| --- | --- | --- | --- |
| nobody | 1588.8 us | 1630.2 us | 1712.3 us |
| one household | 1589.6 us | 1631.3 us | 1714.5 us |
| sixty-four households | 1589.8 us | 1631.1 us | 1724.5 us |
| a copy that is there | 1590.9 us | 1632.4 us | 1717.8 us |

The bands overlap almost exactly. The control for that table is the same case
listed twice under two names: those two differed by 1.17 us, and the widest gap
among the four real cases was 2.21 us. Before the fix, the same table on the
same socket had a widest gap of 96.08 us against a control of 0.58 us.

**What this does not claim.** Not constant time. This is a garbage-collected
runtime on a shared kernel, and four things are named rather than glossed:

- **One branch and one object survive**, at the very end of a read: a hit
  returns a small object and a miss returns null. Everything before that line —
  the digests, the loop, the 512-byte copy — happens either way.
- **The status code still tells a hit from a miss**, in one byte, to whoever
  terminates TLS. It always did, and it is on the residue list above.
- **The runtime is not being promised anything.** A JIT can compile two paths
  differently and a CPU can predict a branch; what is claimed is the number of
  steps this code takes, which is what `escrow/src/cost.test.ts` measures by
  counting digests, signature verifications and encoded bytes rather than by
  trusting a clock. A clock test sits after those as a coarse backstop.
- **The network is louder than anything left.** Over a real path the residue is
  about 0.1% of a response and well inside the jitter — which is an argument
  that it is hard to use, not an argument that it is gone.

Three things that were checked and are **not** channels, measured rather than
reasoned: garbage collections per read are identical once the heap settles
(0.0081 either way — the apparent difference was whichever case ran first);
a bucket nobody has ever written costs the same as one written a second ago,
0.8 us apart against a 2.1 us control, because every block of the file is
written when the file is made; and the service's startup does not depend on how
full the file is, because opening it does not read it.

### The write, which costs something else entirely, and is left that way

Everything above is the read path, where the work is now the same whatever the
file holds. The write path never was the same and is not being made the same. An
accepted write does two `writeSync` and two `fsyncSync` — one for the new image,
one for wiping the copy it replaces. A get does neither. A write refused for its
signature does neither either: it is turned away before a byte reaches the disk.

So the three cost three different amounts and the difference is the disk.
Measured on 7 August 2026 through the image this `Dockerfile` builds, behind the
`Caddyfile` in `deploy/`, over TLS on loopback, one request in flight at a time,
order shuffled every round, 300 rounds of each:

| what was asked | p10 | p50 | p90 |
| --- | --- | --- | --- |
| get, of a copy that is not there | 0.81 ms | 1.07 ms | 2.18 ms |
| put, refused for its signature | 0.88 ms | 1.20 ms | 2.29 ms |
| put, accepted | 2.53 ms | 3.10 ms | 4.43 ms |

The control is the same case under two names: two runs of get(miss) came out
0.00 ms apart at p50, and a get that finds a copy is 0.01 ms from one that does
not — so the hit-against-miss oracle the section above closed is still closed.
The accepted write sits 2.0 ms above both, and the same gap is there with the
proxy taken out of the path (2.45, 2.73 and 5.15 ms straight at the container),
which is how you know it is the disk rather than Caddy.

**Only the gap travels between machines.** A second machine ran the same method
and came out at 1.45, 1.39 and 3.41 ms — different numbers, the same 2 ms. And
these are not the 8 ms a save costs under "Why a file of fixed slots": that is
the same two fsyncs timed in process on a machine where an fsync costs 3.8 ms,
and these are timed end to end through TLS and a proxy on a machine where it
costs about one. Neither is wrong and neither predicts the deployment, which is
EBS. What survives the move is that a save pays two fsyncs and nothing else pays
any.

**One process means everybody waits.** The store does its whole
read-decide-write synchronously, which is what settles two devices racing — so
an fsync stops the one event loop and every request already in flight pays for
it. One put and eight gets fired at the same instant, 320 rounds, the put
accepted in half of them and refused in the other half:

| the eight gets, fired alongside | p10 | p50 | p90 |
| --- | --- | --- | --- |
| an accepted write | 4.03 ms | 6.29 ms | 8.73 ms |
| a write refused for its signature | 1.88 ms | 4.13 ms | 6.32 ms |

Same bytes on the wire, same parse, same bucket, no disk — so the 2.2 ms between
those two rows is the fsyncs, paid by somebody who did not make the write. That
is the channel.

**What it does not carry**, which is the whole of why it is left open. Four
attempts to get more out of it than "a write landed, about now", each measured
on the same rig and each of them a failure:

- **Which household.** Four of the eight gets asked for ids in the write's own
  bucket and four for a bucket 64 away. The write's own bucket answered first on
  47.5% of the accepted rounds and on 45.1% of the refused ones, and the gap
  between the two halves had the same median — 0.53 ms — whether or not anything
  had been written. That is a coin. A bucket is the only function of an id this
  file has, so a delay that cannot name a bucket cannot name an id.
- **Which kind of write.** A first save, a re-save, a clear and a save after a
  clear: 3.17, 3.19, 3.23 and 3.15 ms at p50, a spread of 0.08 ms against a
  control of 0.00. Leaving looks exactly like arriving.
- **Whether a copy is there.** Still 0.01 ms, as above.
- **A cold bucket against a warm one.** The far probes read a bucket nothing had
  touched and the near ones a bucket written a moment before, and they cost the
  same. The file is 10 MB and stays in the page cache. That is a property of its
  size rather than of this design: a file too big to stay resident would have to
  be measured again before this line could be repeated.

**What it does carry.** With eight requests in flight, "that batch was slow, so
a write landed" was right on 94.1% of 320 rounds, against 50% for a coin. An
observer who cannot arrange the overlap does worse: probing without pause and
cutting the clock into 300 ms windows, it caught 49 of 84 writes and cried wolf
in 24 of 76 quiet windows, which is 63%. It can also calibrate itself, because
anybody can make an accepted write — a fresh id at version 1, signed by a key
nobody has seen, is taken and pins that key. One connection sustained 221
accepted writes a second and eight connections 212, so the write path is this
service's ceiling as well as its clock: a bystander's read went from 0.66 ms to
32.6 ms at p50 while that ran.

## Running it

One small instance, Caddy in front, the service on loopback, one file on a
volume. `deploy/README.md` is the whole thing, including the table of every place
a time could still be kept and how each one was checked.

```bash
cd escrow/deploy && docker compose up -d --build
```

There is no schema step and no configuration: the service makes the file when it
opens it, the allowed origin is a constant beside the code it governs, and
`ESCROW_ORIGIN` exists only so a development build can point somewhere else.
`ESCROW_HOUSEHOLDS` is read once, the first time the file is made; after that the
capacity is the file's length and `src/grow.ts` is what changes it.

Deploying from the repository rather than by hand is the point — the
configuration is reviewable, and the next person can see why it looks like this
instead of rediscovering it.

## Not here yet

- **Two devices on one passkey fight over the copy.** Each writes the homes on
  its own disk, so the last save wins. The successor rule keeps the record
  consistent and does not merge anything.
- **No rate limit.** Guessing an id is pointless at 32 bytes, and writing now
  needs the key as well.
- **Growing the file needs the service stopped.** It is a few seconds for a file
  of this size and it is a decision an operator makes, so it has no locking and
  no online path. `src/grow.ts` says what it reveals.
