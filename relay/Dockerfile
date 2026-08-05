# The blind relay.
#
# Node 24 runs TypeScript directly, so there is no build step and no compiled
# artefact that could differ from the source. For a service whose entire claim
# is "it cannot read what it carries", the shipped thing being the reviewed
# thing is worth more than a few megabytes.

FROM node:24-alpine

WORKDIR /srv/relay

# Only `ws`. The relay has one dependency because every one of them is
# something that could learn what the relay must not.
COPY relay/package.json relay/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev --no-audit --no-fund

COPY relay/src ./src
COPY src/lib/carrier/rendezvous.ts ./shared/rendezvous.ts

# Unprivileged, and the image holds nothing worth reading anyway: no database,
# no keys, no state that survives a restart.
USER node

ENV PORT=8787 HOST=0.0.0.0 NODE_ENV=production

EXPOSE 8787

# Answers on /healthz without upgrading, so a supervisor can tell "listening"
# from "alive" without opening a WebSocket.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/main.ts"]
