# The whole store

Kept here as well as in `src/store.ts` so it can be read without reading any
TypeScript: this file and the claim table in `README.md` are what an outsider
checks. A test asserts every number below is the number the code uses, so the
two cannot drift.

Nothing here has to be run by hand. The service makes the file when it opens it
for the first time, because a step that has to be remembered is a step that gets
forgotten.

## Why it is a slot file and not a database

A record's place is a function of its id and of nothing else. Every slot is the
same size and every one of them is written, with random bytes, at the moment the
file is made. A write lands in place and moves nothing.

So the file records **what** is stored and never **when**. That is the property
four rounds of fixes were reaching for: a b-tree keeps the arrival order
structurally — in the page, in the free list, in the page allocation, and in the
journal it writes to rebuild itself — and taking it out one layer at a time is
fighting the tool. Here there is no order to take out.

One file rather than one file per household, for the same reason. A file each is
a modification time each, which is exactly the column the store refuses. This
way there is one modification time for the whole service: the last write by
anybody, saying nothing about which id.

## The numbers

| | bytes |
|---|---|
| id | 32 |
| head (version 4, blob length 2, two zero bytes) | 8 |
| write key, Ed25519 | 32 |
| blob | 512 |
| digest, SHA-256 | 32 |
| **one record** | **616** |
| records in an image (`WAYS`) | 64 |
| **one image** — 64 records and a digest over all of them | **39 456** |
| **one bucket** — two images, side by side | **78 912** |
| households a bucket is sized for | 32 |
| **a household of capacity, on the disk** | **≈ 2 466** |

The file is a whole number of buckets and has no header, no index and no free
list. Its capacity is its length divided by 78 912, times 32.

No header also means no format version, and that is deliberate rather than
forgotten: a field that changes the size of a record changes the size of a
bucket, and the service refuses to open a file whose length is not a whole
number of them. A format change is a file that will not open rather than a file
that is quietly misread.

```
file    │ bucket 0 │ bucket 1 │ … │ bucket n-1 │
bucket  │ image 0                 │ image 1    │
image   │ record 0 │ … │ record 63 │ digest 32 │
record  │ id 32 │ head 8 │ write key 32 │ blob 512 │ digest 32 │
```

## The five rules

1. **A bucket is `sha256("ftw.escrow.slot.bucket.v1" ‖ id)` modulo the bucket
   count.** Nothing else decides it.
2. **Inside a bucket the records are sorted by id and packed from the front.**
   Not "wherever there was room": the first free slot is the arrival order
   written back into the file. Sorting means a record's place is a function of
   the set of ids in its bucket, which is what makes two files built from the
   same households in opposite orders come out the same bytes.
3. **A slot holds a record if and only if its digest checks out.** Random bytes
   do not, so an empty slot needs no marker and the file can be noise from the
   moment it is made — and a half-written slot is refused rather than read.
   Every slot of both images is checked on every read, whether or not the bucket
   holds anybody: stopping early made an empty bucket cheaper to read than an
   occupied one, which is a household counter for anyone with a stopwatch.
   `README.md` has the measurements under "What a request costs".
4. **A write goes into the image the current one is not in, and only then is the
   old one wiped with fresh random bytes.** So at every instant at least one
   image of a bucket is whole, which is atomicity with no journal; and once the
   wipe is done the copy a household replaced is not anywhere.
5. **The current image is the whole one whose versions add up to more.** Every
   accepted write adds exactly one to that total, so it rises with each write and
   nothing here counts writes or reads a clock. The parity of the total says
   which of the two images the next write goes into.

## The head is masked, and that is not encryption

A version is a small number and a length is 0 or 512, so both would stand out
in a file that is otherwise indistinguishable from random — and a byte histogram
would then count the households without knowing anything else about the file.
Those eight bytes are XORed with `sha256("ftw.escrow.slot.head.v1" ‖ id)`.

The id is in the same slot, so anyone who knows this layout unmasks it in a line.
It defeats the tool that does not: a histogram, a compressor, `strings`, a search
for runs of zeroes. `README.md` says exactly that rather than claiming more.

## Who may write

A write carries an Ed25519 public key and a signature over

```
ftw-escrow:v1:<id>:<version>:<sha256 of the blob, hex>
```

The first write pins the key. Every later write must present the same one —
compared in constant time — and a signature that checks out under it. Reading is
the id alone, deliberately, because a fresh install has a passkey and nothing
else and has to be able to read.

## What is not here

No account, no email, no box id, no site id, no device id, no address, no user
agent, no created-at, no updated-at, no access log, no expiry and no garbage
collection. There is no verb that removes a record either: a household that
leaves writes zero bytes at the next version, so the count carries on and an old
copy cannot be written back. `README.md` has the reasoning.
