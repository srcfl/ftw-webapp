/* Run the relay.
 *
 *   PORT=8787 node relay/src/main.ts
 *
 * Four environment variables and no configuration file. Everything else is a
 * constant in server.ts, where it can be read alongside the code it governs.
 */

import { RelayServer } from './server.ts'

const relay = await RelayServer.start({
  port: Number(process.env['PORT'] ?? 8787),
  host: process.env['HOST'] ?? '0.0.0.0',
  // Only when something trusted terminates TLS in front. The relay reads
  // X-Forwarded-For to rate-limit, and behind a terminator that header is the
  // only way it sees more than one address — but exposed directly it is a
  // value the client types, and anyone could spread themselves across the
  // whole counter array.
  trustProxy: process.env['RELAY_TRUST_PROXY'] === '1',
  // The dead man rows — the relay's only file. Unset disables the switch.
  deadmanPath: process.env['RELAY_DEADMAN_PATH'] ?? '',
  // Counts only. A handle here would be the household identifier this whole
  // design exists to avoid handing over.
  log: (line) => console.log(new Date().toISOString() + ' ' + line),
})

console.log(`relay listening on ${relay.url}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void relay.stop().then(() => process.exit(0))
  })
}
