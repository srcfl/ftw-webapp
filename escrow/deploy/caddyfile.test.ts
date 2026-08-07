// @vitest-environment node

/* The proxy, held to writing nothing down.
 *
 * This is a test about configuration, which is a weaker kind of test and is
 * marked as such in README.md. It cannot prove what Caddy does; only running
 * Caddy can, and README.md carries the commands for that under "Checking it by
 * running it". What it can do is catch the two ways this went wrong before,
 * both of which were one line in a file nobody re-read:
 *
 *   an access log that was filtered rather than absent, whose surviving fields
 *     told a save from a read from a miss by byte count alone;
 *   a global log block with no filter at all, where one proxy error wrote the
 *     client address, the URI and every request header beside the time.
 *
 * So the rule this holds is a shape and not a list of forbidden fields: every
 * log block in the file discards. A filter is a list of the fields somebody
 * thought of, and that is exactly what failed.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const caddyfile = readFileSync(new URL('./Caddyfile', import.meta.url), 'utf8')
const compose = readFileSync(new URL('./compose.yml', import.meta.url), 'utf8')

/** The body of every `log { … }` block, comments stripped. */
function logBlocks(text: string): string[] {
  const source = text.replace(/^\s*#.*$/gm, '')
  const blocks: string[] = []
  const opener = /(^|\s)log\s*\{/g
  let match: RegExpExecArray | null
  while ((match = opener.exec(source))) {
    let depth = 1
    let at = opener.lastIndex
    while (at < source.length && depth > 0) {
      if (source[at] === '{') depth++
      if (source[at] === '}') depth--
      at++
    }
    blocks.push(source.slice(opener.lastIndex, at - 1).trim())
  }
  return blocks
}

describe('the proxy in front of the escrow', () => {
  it('discards every log it has, rather than filtering them', () => {
    const blocks = logBlocks(caddyfile)

    // Two: Caddy's own diagnostics in the global options, and the site's
    // access log. Neither may be dropped instead of discarded — without the
    // global block the default logger goes back to stderr, where Docker keeps
    // it, and a proxy error there names the address and the URI.
    expect(blocks.length, 'a log block went missing, which is not the same as discarded')
      .toBeGreaterThanOrEqual(2)

    for (const [index, block] of blocks.entries()) {
      expect(block.split('\n').map((line) => line.trim()).filter(Boolean), `log block ${index}`)
        .toEqual(['output discard'])
    }
  })

  it('keeps no file to write to and no filter to get wrong', () => {
    // Named one by one because each is a way the old file kept a record: a
    // file to roll, a filter that deleted the fields somebody thought of, and
    // a volume to hold what neither should produce.
    for (const forbidden of ['output file', 'output stdout', 'output stderr', 'format filter', 'fields {']) {
      expect(caddyfile, `the Caddyfile still has \`${forbidden}\``).not.toContain(forbidden)
    }
    expect(compose, 'the compose file still mounts a log volume').not.toContain('caddy-logs')
    expect(compose).not.toContain('/var/log/caddy')
  })

  it('turns the admin endpoint off', () => {
    // On by default on 127.0.0.1:2019, and `network_mode: host` makes that the
    // host's loopback. It serves the running config unauthenticated and takes
    // a new one, so everything above would be one POST away from untrue.
    expect(caddyfile).toContain('admin off')
    expect(compose).toContain('network_mode: host')
  })

  it('caps what Docker keeps for both containers', () => {
    // The escrow prints nothing and Caddy prints nothing once its config is in
    // force. This is for what Caddy prints *before* that — a bad Caddyfile —
    // which is the one thing that can accumulate.
    expect(compose.match(/max-size: '1m'/g), 'a container has no log cap').toHaveLength(2)
  })
})
