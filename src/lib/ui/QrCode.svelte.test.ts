/* The square, decoded.
 *
 * This is the test the encoder's own history demands. The box shipped four
 * tests against it that all passed while it produced symbols no reader could
 * decode above type 6 — they asserted module counts, finder patterns, squareness
 * and a dark-module checksum, and not one of them read the thing back. A
 * pairing payload is 156 characters and lands on type 9, which is exactly the
 * range that was broken.
 *
 * So this reads back what the component actually put in the document: the
 * path's own module coordinates, rasterised and handed to jsQR — the same
 * decoder the app's camera uses. Nothing here trusts the encoder's word for
 * what it drew.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import QrCode, { QUIET } from './QrCode.svelte'
import { buildEnrollmentUrl } from '$lib/identity/enrollment'
import { darkModules, decodeDrawnQr, symbolSpan } from '../../../tests/support/qr'

/** A real payload: the one an invitation hands out. 156 characters. */
const PAYLOAD = buildEnrollmentUrl({
  boxStaticPublic: new Uint8Array(32).map((_, i) => (i * 7 + 11) & 0xff),
  pairingCode: new Uint8Array(16).map((_, i) => (i * 31 + 5) & 0xff),
  rendezvousSecret: new Uint8Array(32).map((_, i) => (i * 13 + 3) & 0xff),
  lanHint: '192.168.1.44:8080',
})

async function drawn(text: string): Promise<SVGSVGElement> {
  render(QrCode, { props: { text, label: 'Pairing code for this home' } })
  return vi.waitFor(() => {
    const svg = document.querySelector('svg')
    expect(svg, 'nothing was drawn').toBeTruthy()
    return svg as SVGSVGElement
  })
}

afterEach(() => document.body.replaceChildren())

describe('a payload drawn as a square', () => {
  it('reads back as exactly what went in', async () => {
    const svg = await drawn(PAYLOAD)

    expect(decodeDrawnQr(svg), 'the drawn symbol did not decode').toBe(PAYLOAD)
  })

  it('is big enough for a real payload to need the version block', async () => {
    // A pairing payload is past type 6, which is where the encoder was broken
    // and where a reader has to be told the version rather than guess. A
    // future payload that shrank under that line would quietly stop covering
    // the case this test exists for.
    const svg = await drawn(PAYLOAD)
    const modules = symbolSpan(svg) - 2 * QUIET

    expect((modules - 17) / 4, 'the payload no longer reaches type 7').toBeGreaterThanOrEqual(7)
  })

  it('keeps the quiet zone, which is what a camera finds the symbol by', async () => {
    const svg = await drawn(PAYLOAD)
    const span = symbolSpan(svg)
    const dark = darkModules(svg.querySelector('path')!.getAttribute('d')!)

    for (const cell of dark) {
      const [x, y] = cell.split(',').map(Number) as [number, number]
      expect(Math.min(x, y), 'a module sits in the margin').toBeGreaterThanOrEqual(QUIET)
      expect(Math.max(x, y), 'a module sits in the margin').toBeLessThan(span - QUIET)
    }
  })

  it('is drawn dark on light, whatever the app’s theme is', async () => {
    // An inverted symbol is one many phone cameras will not read, and the app
    // is dark by default.
    const svg = await drawn(PAYLOAD)

    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('#ffffff')
    expect(svg.querySelector('path')!.getAttribute('fill')).toBe('#000000')
  })

  it('says what it is to someone who cannot see it', async () => {
    const svg = await drawn(PAYLOAD)

    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe('Pairing code for this home')
  })
})
