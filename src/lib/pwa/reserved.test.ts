/* The one case where honouring the safe area reserves it twice.
 *
 * The numbers in the first test are the ones measured off Fredrik's phone
 * with a probe shipped for the purpose: an installed app whose window ends
 * at 812 of an 846-point screen while the inset still claims 34px. Every
 * other row is a case that must keep its clearance, because there the inset
 * is the only thing holding the tab bar off the indicator.
 */

import { describe, it, expect } from 'vitest'
import { reservedByTheOs } from './reserved'

describe('who reserved the home indicator', () => {
  it('is the system, on an installed iOS app laid out short of the screen', () => {
    expect(
      reservedByTheOs({ standalone: true, innerHeight: 812, screenHeight: 846, insetBottom: 34 })
    ).toBe(true)
  })

  it('is us, in a Safari tab — the window is the screen and the inset is real', () => {
    expect(
      reservedByTheOs({ standalone: false, innerHeight: 846, screenHeight: 846, insetBottom: 34 })
    ).toBe(false)
  })

  it('is us, on an installed app whose window really does reach the bottom', () => {
    // Android's standalone, and any future iOS that stops insetting: the
    // window is the whole screen, so the inset is the only clearance there is.
    expect(
      reservedByTheOs({ standalone: true, innerHeight: 846, screenHeight: 846, insetBottom: 34 })
    ).toBe(false)
  })

  it('is nobody, on a screen with no indicator at all', () => {
    expect(
      reservedByTheOs({ standalone: true, innerHeight: 800, screenHeight: 846, insetBottom: 0 })
    ).toBe(false)
  })

  it('is us, anywhere the platform does not answer the question', () => {
    // `standalone` is an iOS-only property; undefined is every other browser,
    // and none of them inset a window behind the page's back.
    expect(
      reservedByTheOs({ standalone: undefined, innerHeight: 812, screenHeight: 846, insetBottom: 34 })
    ).toBe(false)
  })
})
