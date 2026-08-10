/* The CSP against the code that has to live under it.
 *
 * connect-src is the app's whole list of who it may call, and it is the
 * exfiltration guard: a compromised build meets the browser's refusal.
 * But a list nothing checks rots the other way too — the escrow shipped,
 * worked from every curl, and died in every browser, because the policy
 * predated it. This test holds the list to the origins the code names,
 * so the next origin added in code fails here instead of in a hand.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ESCROW_ORIGIN } from '../src/lib/identity/escrow'
import { RELAY_HOST } from '../src/lib/identity/origin'

function connectSrc(): string {
  const headers = readFileSync('public/_headers', 'utf8')
  const csp = headers.match(/Content-Security-Policy: ([^\n]+)/)?.[1]
  expect(csp, 'no CSP in public/_headers at all').toBeDefined()
  const connect = csp!.match(/connect-src ([^;]+)/)?.[1]
  expect(connect, 'a CSP with no connect-src allows everything').toBeDefined()
  return connect!
}

describe('the connect-src list', () => {
  it('carries every origin the code calls', () => {
    const list = connectSrc()
    expect(list, 'the escrow is unreachable from a browser').toContain(ESCROW_ORIGIN)
    expect(list, 'the relay is unreachable from a browser').toContain(RELAY_HOST)
  })

  it('never grows a wildcard', () => {
    // The guard is the explicitness. A '*' here would pass every origin
    // test above while deleting the property they exist for.
    expect(connectSrc()).not.toContain('*')
  })
})
