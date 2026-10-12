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
  const [global, site, ...rest] = logBlocks(caddyfile)

  it('has exactly two log blocks: the global one and the site access log', () => {
    // Without the global block the default logger goes back to stderr,
    // where Docker keeps it.
    expect(global, 'the global log block went missing').toBeDefined()
    expect(site, 'the site access log went missing').toBeDefined()
    expect(rest, 'a new log block needs its own rule here').toEqual([])
  })

  it("discards Caddy's own diagnostics", () => {
    expect(global.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual(['output discard'])
  })

  it('deletes the handle, the headers and every address from the access log', () => {
    for (const field of ['request>uri delete', 'request>headers delete', 'request>remote_ip delete', 'request>client_ip delete']) {
      expect(site, `the access log keeps ${field.split(' ')[0]}`).toContain(field)
    }
  })

  it('never writes a log to stdout or stderr, where Docker keeps it', () => {
    expect(caddyfile).not.toContain('output stdout')
    expect(caddyfile).not.toContain('output stderr')
  })
})
