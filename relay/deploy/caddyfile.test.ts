// @vitest-environment node

/* The proxy in front of the relay, held to keeping no address.
 *
 * Like the escrow's test, this checks configuration, which cannot prove what
 * Caddy does. It catches the one line that went wrong: Caddy's own
 * diagnostics went to a file with no filter, so one proxy error wrote the
 * client address and the URI, which carries the rendezvous handle, beside the
 * time. Go's TLS handshake errors put the address in the message text, where
 * a field filter cannot reach it, so the diagnostics are discarded.
 *
 * The site's access log stays, because the operator reads aggregate traffic
 * from it. Its filter must keep deleting the fields that name a household or
 * an address.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const caddyfile = readFileSync(new URL('./Caddyfile', import.meta.url), 'utf8')

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

describe('the proxy in front of the relay', () => {
  const blocks = logBlocks(caddyfile)
  const global = blocks[0] ?? ''
  const site = blocks[1] ?? ''

  it('has exactly two log blocks: the global one and the site access log', () => {
    // Without the global block the default logger goes back to stderr,
    // where Docker keeps it. A third block needs its own rule here.
    expect(blocks.length, 'expected the global log and the site access log, and nothing else').toBe(2)
  })

  it("discards Caddy's own diagnostics", () => {
    expect(global.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual(['output discard'])
  })

  it('deletes the handle, the headers and every address from the access log', () => {
    for (const field of ['request>uri delete', 'request>headers delete', 'request>remote_ip delete', 'request>client_ip delete']) {
      expect(site, `the access log keeps ${field.split(' ')[0]}`).toContain(field)
    }
  })

  it('writes no access log line for a watch exchange', () => {
    // A line per request keeps a time, sizes and a duration even with the
    // URI and addresses cut. On /x/ that is a line per command.
    const source = caddyfile.replace(/^\s*#.*$/gm, '')
    const matcher = /@(\w+)\s+path\s+\/x\/\*\s*$/m.exec(source)
    expect(matcher, 'no matcher for /x/*').not.toBeNull()
    expect(source).toMatch(new RegExp(`^\\s*log_skip\\s+@${matcher![1]}\\s*$`, 'm'))
  })

  it('never writes a log to stdout or stderr, where Docker keeps it', () => {
    expect(caddyfile).not.toContain('output stdout')
    expect(caddyfile).not.toContain('output stderr')
  })
})
