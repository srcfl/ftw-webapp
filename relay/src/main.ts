/* Run the relay.
 *
 *   PORT=8787 node --experimental-strip-types relay/src/main.ts
 *
 * Two environment variables and no configuration file. Everything else is a
 * constant in server.ts, where it can be read alongside the code it governs.
 */

import { RelayServer } from './server.ts'

const relay = await RelayServer.start({
  port: Number(process.env['PORT'] ?? 8787),
  host: process.env['HOST'] ?? '0.0.0.0',
  // Counts only. A handle here would be the household identifier this whole
  // design exists to avoid handing over.
  log: (line) => console.log(line),
})

console.log(`relay listening on ${relay.url}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void relay.stop().then(() => process.exit(0))
  })
}
