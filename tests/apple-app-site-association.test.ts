/* The file that ties the native iPhone app to app.ftw.energy.
 *
 * Passkeys are bound to this domain. Without this file the app cannot use
 * them, so one passkey would not open the same home on the web and in the
 * app. Apple fetches it without a browser, so a typo shows up only as a
 * passkey prompt that never appears on a phone. These tests catch it here.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP_ID = 'L66M368PZ6.energy.ftw.app'
const PATH = '/.well-known/apple-app-site-association'

type Aasa = {
  webcredentials?: { apps?: string[] }
  applinks?: { details?: { appIDs?: string[]; components?: { '/'?: string }[] }[] }
}

function aasa(): Aasa {
  return JSON.parse(readFileSync(`public${PATH}`, 'utf8')) as Aasa
}

describe('the apple-app-site-association file', () => {
  it('lets the app use passkeys made on this domain', () => {
    expect(aasa().webcredentials?.apps).toEqual([APP_ID])
  })

  it('opens the app only for pairing and for an assistant\'s consent link', () => {
    const details = aasa().applinks?.details ?? []
    expect(details.map(d => d.appIDs)).toEqual([[APP_ID]])
    const paths = details.flatMap(d => d.components ?? []).map(c => c['/'])
    expect(paths).toEqual(['/p', '/a', '/a/*'])
    // The web app answers the same path, so a phone without the app still pairs.
    const redirects = readFileSync('public/_redirects', 'utf8')
    expect(redirects).toMatch(/^\/p \/index\.html 200$/m)
  })

  it('answers a consent link without the app with a page that sends you to it', () => {
    const redirects = readFileSync('public/_redirects', 'utf8')
    expect(redirects).toMatch(/^\/a \/access-link\.html 200$/m)
    expect(redirects).toMatch(/^\/a\/\* \/access-link\.html 200$/m)
    const page = readFileSync('public/access-link.html', 'utf8')
    expect(page).toContain('Open this on your iPhone with FTW')
    // It approves nothing and reads nothing: no script, no form, no fetch.
    expect(page).not.toMatch(/<script|<form|fetch\(/i)
  })

  it('is served as JSON', () => {
    const headers = readFileSync('public/_headers', 'utf8')
    const block = headers.split(/\n(?=\S)/).find(b => b.startsWith(`${PATH}\n`))
    expect(block, `no _headers rule for ${PATH}`).toBeDefined()
    expect(block).toMatch(/^\s+Content-Type: application\/json$/m)
  })
})
