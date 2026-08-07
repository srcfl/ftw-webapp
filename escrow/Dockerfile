# The sealed escrow.
#
# Node runs TypeScript directly, so there is no build step and no compiled
# artefact that could differ from the source. For a service whose entire claim
# is "it cannot open what it holds, and it knows nothing else", the shipped
# thing being the reviewed thing is worth more than a few megabytes.
#
# The Node line is the one the tests run on, and that is not housekeeping: the
# store's guarantees — what a write leaves in the file, whether a half-written
# slot is refused — are asserted against this runtime on every run, and the
# signature check is this runtime's Ed25519.

FROM node:26-alpine

WORKDIR /srv/escrow

# No dependencies at all. The wire is JSON, the store is one file this code
# writes itself, and the only cryptography is a hash and a signature check, both
# in the standard library — so there is no package.json to install and nothing
# in the image that could learn anything.
COPY escrow/src ./src
COPY escrow/layout.md ./layout.md

# The file lives on a volume so a rebuild does not take a household's copy with
# it. Owned by the unprivileged user the process runs as. It is made once, at
# the capacity ESCROW_HOUSEHOLDS asks for, and grown by escrow/src/grow.ts with
# the service stopped — never by changing that number on a running host.
RUN mkdir -p /srv/escrow/data && chown -R node:node /srv/escrow
USER node

ENV ESCROW_DB=/srv/escrow/data/escrow.slots PORT=8788 ESCROW_HOUSEHOLDS=4096 NODE_ENV=production

EXPOSE 8788

# The only thing this service says out loud. It touches the file rather than
# only the socket, because the process writes no log — so "listening" and "the
# disk is still there" have to be told apart here or nowhere.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/main.ts"]
