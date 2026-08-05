import { describe, it, expect, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen } from '@testing-library/svelte'
import Pair from './Pair.svelte'
import { buildEnrollmentUrl } from '$lib/identity/enrollment'

/* A pairing link must never pair by itself.
 *
 * A link is something anyone can send — by SMS, by email, on a sticker over
 * the real QR. This screen used to pair the moment a fragment arrived, so
 * "your box needs re-pairing, tap here" silently repointed the app at the
 * sender's box: their readings shown as this home, every mode change sent to
 * their hardware, and no way back without the physical code. On a device
 * without PRF it cost the owner not one tap.
 */

const ATTACKER_KEY = new Uint8Array(32).fill(0xbb)

function fragmentFor(key: Uint8Array): string {
  const url = buildEnrollmentUrl({
    boxStaticPublic: key,
    pairingCode: new Uint8Array(16).fill(1),
    rendezvousSecret: new Uint8Array(32).fill(2),
    lanHint: '',
  })
  return '#' + url.split('#')[1]
}

describe('a pairing link that arrives on its own', () => {
  it('is shown as an offer and pairs nothing until someone agrees', async () => {
    const onPaired = vi.fn()
    render(Pair, { props: { fragment: fragmentFor(ATTACKER_KEY), onPaired } })

    // The decisive assertion: nothing was paired by the mere arrival of a link.
    await new Promise((r) => setTimeout(r, 50))
    expect(onPaired, 'a link paired the app without being asked').not.toHaveBeenCalled()

    // And the user is told what they would be trusting, by name.
    const heading = await screen.findByRole('heading')
    expect(heading.textContent).toMatch(/connect this box\?/i)
    expect(await screen.findByRole('button', { name: /connect this box/i })).toBeTruthy()
    expect(await screen.findByRole('button', { name: /not now/i })).toBeTruthy()
  })

  it('names the box it points at, so two boxes look different', async () => {
    render(Pair, { props: { fragment: fragmentFor(ATTACKER_KEY), onPaired: vi.fn() } })

    // Six hex characters of the key's digest. Nobody memorises it, but it is
    // what makes "this is not the box on my wall" noticeable at all.
    const body = document.body.textContent ?? ''
    await vi.waitFor(() => expect(body.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 50))
    expect(document.body.textContent).toMatch(/[0-9A-F]{6}/)
  })

  it('refuses a link that is not an FTW code, without pairing anything', async () => {
    const onPaired = vi.fn()
    render(Pair, { props: { fragment: '#not-a-pairing-code', onPaired } })

    await new Promise((r) => setTimeout(r, 50))
    expect(onPaired).not.toHaveBeenCalled()
    expect(document.body.textContent).toMatch(/not an FTW pairing code/i)
  })
})
