/* Reading a drawn QR back, without a camera or a canvas.
 *
 * The app draws a symbol as one SVG path of unit squares. This turns that
 * path back into pixels and hands them to jsQR — the same decoder the camera
 * path uses — so a test can assert what a phone pointed at the screen would
 * actually get.
 *
 * It exists because the encoder's history is four tests that passed against a
 * symbol nothing could read. Asserting on module counts, finder patterns or a
 * dark-module checksum is what let that through. Decode, or do not test it.
 *
 * Not a test file — vitest collects `tests/ **\/*.test.ts` only.
 */

import jsQR from 'jsqr'

/** Every `M x y` in the path: the dark modules, in viewBox coordinates. */
export function darkModules(d: string): Set<string> {
  const out = new Set<string>()
  for (const [, x, y] of d.matchAll(/M(\d+) (\d+)h1v1h-1Z/g)) out.add(`${x},${y}`)
  return out
}

/** The side of the symbol in modules, quiet zone included. */
export function symbolSpan(svg: SVGSVGElement): number {
  return Number(svg.getAttribute('viewBox')!.split(' ')[2])
}

/**
 * What a camera pointed at this element would read, or null.
 *
 * Eight pixels a module: jsQR resamples, and one pixel per module leaves it
 * nothing to resample. The quiet zone comes from the viewBox rather than
 * being added here, so a component that forgot it fails rather than being
 * quietly rescued by the test.
 */
export function decodeDrawnQr(svg: SVGSVGElement): string | null {
  const span = symbolSpan(svg)
  const dark = darkModules(svg.querySelector('path')!.getAttribute('d')!)

  const scale = 8
  const side = span * scale
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255)

  for (const cell of dark) {
    const [x, y] = cell.split(',').map(Number) as [number, number]
    for (let py = y * scale; py < (y + 1) * scale; py++) {
      for (let px = x * scale; px < (x + 1) * scale; px++) {
        const at = (py * side + px) * 4
        pixels[at] = 0
        pixels[at + 1] = 0
        pixels[at + 2] = 0
      }
    }
  }

  return jsQR(pixels, side, side)?.data ?? null
}
