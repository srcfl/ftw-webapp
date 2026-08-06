import { describe, it, expect, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import FreshnessBand from './FreshnessBand.svelte'

/* What the band is allowed to claim.
 *
 * Two orthogonal facts and no diagnosis it has not confirmed. The case below
 * is the one where the two most easily contradict each other: a box that is
 * perfectly reachable and has told this phone to leave.
 */
describe('the freshness band on a phone whose access ended', () => {
  afterEach(() => document.body.replaceChildren())

  it('does not blame the connection for a decision about the phone', () => {
    render(FreshnessBand, {
      props: { carrier: 'none', srcState: 'stale', ageMs: 7_200_000, phase: 'terminated' },
    })

    // Now.svelte says "Access ended — your access to this home was withdrawn
    // by its owner" directly below. Sending someone to check their wifi over
    // that is the app disagreeing with itself on one screen.
    expect(document.body.textContent).not.toMatch(/can't reach your box/i)
    expect(document.body.textContent).toMatch(/access ended/i)
  })

  it('still says a box it cannot reach is a box it cannot reach', () => {
    render(FreshnessBand, {
      props: { carrier: 'none', srcState: 'stale', ageMs: 60_000, phase: 'failed' },
    })

    expect(document.body.textContent).toMatch(/can't reach your box/i)
  })
})
