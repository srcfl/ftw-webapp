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

  it('says when no carrier exists instead of promising a retry', () => {
    render(FreshnessBand, {
      props: {
        carrier: 'none',
        srcState: 'stale',
        ageMs: 60_000,
        phase: 'failed',
        noCarrier: true,
      },
    })

    expect(document.body.textContent).toMatch(/can't reach your box/i)
  })

  it('shows a retry and its elapsed time while the carrier heals itself', () => {
    render(FreshnessBand, {
      props: {
        carrier: 'none',
        srcState: 'stale',
        ageMs: 60_000,
        phase: 'failed',
        waitMs: 7_000,
      },
    })

    expect(document.body.textContent).toMatch(/reconnecting to your box/i)
    expect(document.body.textContent).toMatch(/7s/i)
    expect(document.body.textContent).not.toMatch(/can't reach your box/i)
  })

  it('uses live only for live readings over the relay', () => {
    render(FreshnessBand, {
      props: { carrier: 'relay', srcState: 'stale', ageMs: 5_000, phase: 'streaming' },
    })

    expect(document.body.textContent).toMatch(/encrypted relay connected/i)
    expect(document.body.textContent).not.toMatch(/\blive\b/i)
  })

  it('agrees with the starting screen and shows the box progress', () => {
    render(FreshnessBand, {
      props: {
        carrier: 'none',
        transport: 'relay',
        srcState: 'stale',
        ageMs: 5_000,
        phase: 'booting',
        bootPct: 40,
      },
    })

    expect(document.body.textContent).toMatch(/your box is starting/i)
    expect(document.body.textContent).toMatch(/40%/)
    expect(document.body.textContent).not.toMatch(/can't reach|\blive\b/i)
  })
})
