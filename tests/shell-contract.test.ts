/* The shell, held to fitting any phone.
 *
 * jsdom computes no layout, so the thing worth proving here cannot be
 * measured by rendering: it is the handful of CSS decisions that make the
 * shell fill whatever screen it is given. Each one below was arrived at by
 * getting it wrong on a real phone first, and each one silently un-fixes the
 * app if someone edits it back.
 *
 * Measured in a browser at 320x568, 430x932 and 844x390 (landscape) when
 * this was written: the tab bar sat on the bottom edge with no gap at every
 * one, and the view scrolled inside itself rather than pushing the bar off.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const shell = readFileSync('src/App.svelte', 'utf8')

/** The `<style>` block, so a comment elsewhere cannot satisfy a check. */
function css(): string {
  const at = shell.lastIndexOf('<style>')
  expect(at, 'App.svelte has no style block').toBeGreaterThan(-1)
  return shell.slice(at)
}

function rule(selector: string): string {
  const text = css()
  const at = text.indexOf(`\n  ${selector} {`)
  expect(at, `no ${selector} rule in the shell`).toBeGreaterThan(-1)
  return text.slice(at, text.indexOf('\n  }', at))
}

describe('the shell fits any screen', () => {
  it('is pinned to the viewport rather than sized by arithmetic', () => {
    // `height: calc(100dvh - inset)` was the first attempt and it is a sum of
    // two numbers a browser can disagree about; `height: 100%` was the second
    // and it collapses, because the mount target between body and here has no
    // height of its own (measured: 702 of 812). Pinning all four edges asks
    // the browser for the viewport instead of computing it.
    const app = rule('.app')
    expect(app).toMatch(/position:\s*fixed/)
    expect(app).toMatch(/inset:\s*0/)
    expect(app, 'a height would fight the pinning').not.toMatch(/\n\s*height:/)
  })

  it('keeps the tab bar on the bottom edge', () => {
    // `main` grows to fill, so this is belt: if anything ever stops it
    // growing, the bar still sits on the edge instead of floating up and
    // leaving bare shell under it.
    expect(rule('nav')).toMatch(/margin-top:\s*auto/)
    expect(rule('main')).toMatch(/flex:\s*1/)
    expect(rule('main'), 'the view must scroll inside itself').toMatch(/overflow-y:\s*auto/)
  })

  it('clears the home indicator without stacking padding on top of it', () => {
    // max, never a sum: added together they made a strip of empty bar below
    // the labels that reads as dead space on a phone, and on a screen with no
    // indicator the inset is 0 and the ordinary padding must still apply.
    const nav = rule('nav')
    expect(nav).toMatch(/padding-bottom:\s*max\(/)
    expect(nav).toMatch(/env\(safe-area-inset-bottom\)/)
    expect(nav, 'the insets are being added rather than compared').not.toMatch(
      /padding-bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)/
    )
  })

  it('runs into the strip below it rather than ending at a seam', () => {
    // Below an installed app's web view is a strip of screen iOS paints and
    // no CSS here can reach; it carries the app's own background. A bar in
    // its own shade would end against that strip in a visible line — which
    // is what a raised bar looked like — so the bar takes the same surface
    // and one rule across the top is what says "bar" instead.
    const nav = rule('nav')
    expect(nav).toMatch(/background:\s*var\(--surface\)/)
    expect(nav, 'a bar with no visible edge is not a bar').toMatch(/border-top:/)
  })

  it('puts the labels on the edge where the system already cleared it', () => {
    // Measured: an installed iOS app is laid out short of the screen, so the
    // indicator is already clear and anything below the labels is a gap
    // between the bar and the strip it should be continuous with.
    const reserved = rule(':global(html.reserved-by-the-os) nav')
    expect(reserved).toMatch(/padding-bottom:\s*0/)
  })

  it('reserves the notch on the shell, so the bar is free to reach the edge', () => {
    // Both insets on one element would have the shell end short of the
    // bottom; the top is reserved here and the bottom belongs to the bar.
    const app = rule('.app')
    expect(app).toMatch(/padding:\s*env\(safe-area-inset-top\)/)
    expect(app, 'a bottom inset here would lift the bar off the edge').toMatch(
      /padding:[^;]*\s0\s+env\(safe-area-inset-left\)/
    )
  })
})
