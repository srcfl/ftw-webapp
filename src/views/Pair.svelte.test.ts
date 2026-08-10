import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen } from '@testing-library/svelte'
import Pair from './Pair.svelte'
import { buildEnrollmentUrl } from '$lib/identity/enrollment'
import { installMockAuthenticator, type MockAuthenticator } from '../../tests/support/passkey'
import {
  deviceKey,
  enrollWrappingKey,
  isEnrolled,
  memoryVaultStore,
  openVaultStore,
} from '$lib/identity/vault'
import { db, type StoredSite } from '$lib/store/db'

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

/* The other way in, for a phone whose storage is gone and whose passkey is not.
 *
 * The rule this screen must not break is the app's first one: nothing stands
 * in front of the first frame, and a passkey sheet is the most conspicuous
 * thing that could. So the offer is a button and the answer is only fetched
 * when someone presses it — which also means a person who never saved a copy
 * is never shown a sheet at all.
 */
describe('bringing a home back from a sealed copy', () => {
  let mock: MockAuthenticator | null = null

  // The screens above this one are never unmounted, and two Pair components in
  // one document make every query ambiguous.
  beforeEach(() => document.body.replaceChildren())

  afterEach(() => {
    mock?.uninstall()
    mock = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('offers it, and opens no passkey sheet until it is tapped', async () => {
    mock = installMockAuthenticator()
    const asked = vi.fn(async () => new Response('{}', { status: 404 }))
    vi.stubGlobal('fetch', asked)

    render(Pair, { props: { onPaired: vi.fn() } })
    await new Promise((r) => setTimeout(r, 50))

    expect(screen.getByRole('button', { name: /set this up before/i })).toBeTruthy()
    expect(mock.getCalls, 'the pairing screen opened a passkey sheet on arrival').toBe(0)
    expect(asked, 'the pairing screen reached for a copy nobody asked for').not.toHaveBeenCalled()
  })

  it('says there is nothing saved, rather than showing a fault', async () => {
    // The ordinary answer for a passkey that never opted in. Shown as an
    // error it sends someone hunting for a problem that is not there.
    mock = installMockAuthenticator()
    // A passkey that exists and has never escrowed anything. Without one the
    // authenticator answers NotAllowedError — the same DOMException a
    // dismissed sheet gives — and no platform tells those two apart, so the
    // screen stays quiet, which is what a dismissal has to do.
    await enrollWrappingKey(memoryVaultStore())
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))

    render(Pair, { props: { onPaired: vi.fn() } })
    ;(await screen.findByRole('button', { name: /set this up before/i })).click()

    await vi.waitFor(() =>
      expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toMatch(
        /Nothing was saved for this passkey/i
      )
    )
    // Still on the screen it started on, with the scan still offered.
    expect(screen.getByRole('button', { name: /set this up before/i })).toBeTruthy()
  })
})

/* The way back in without a camera.
 *
 * The box shows eight characters and its own page says: read this out, and on
 * the other phone choose to type a code rather than scan one. This is that
 * other phone. A screen that can only scan makes the floor unreachable for
 * exactly the person standing on it — no camera, a cracked lens, or somebody
 * being read a code down a phone line.
 */
describe('typing a code the box read out', () => {
  const SITE = 'aaaabbbbccccdddd'
  let mock: MockAuthenticator | null = null

  async function knownHome(): Promise<void> {
    // `known` is the precondition for the offer: this phone has a key and a
    // home, and the box has stopped letting it in. The device key has to
    // exist and not merely the passkey — that is what "enrolled" means here.
    // Enrolled once for the whole block: the vault outlives a test, and a
    // second enrolment would register a second credential the first vault
    // record has no wrapped copy for.
    const store = openVaultStore()
    if (!(await isEnrolled(store))) await deviceKey(store, await enrollWrappingKey(store))
    const database = await db()
    for (const row of await database.getAll('sites')) await database.delete('sites', row.siteId)
    await database.put('sites', {
      siteId: SITE,
      label: 'Home',
      boxStaticKey: new Uint8Array(32).fill(7),
      rendezvousSecret: new Uint8Array(32).fill(9),
      addedAtMs: 1,
      lastSeenAtMs: 1,
    } satisfies StoredSite)
  }

  function field(): HTMLInputElement {
    return document.querySelector('input') as HTMLInputElement
  }

  function type(text: string): void {
    field().value = text
    field().dispatchEvent(new Event('input', { bubbles: true }))
  }

  function buttonSaying(pattern: RegExp): HTMLButtonElement | undefined {
    return [...document.querySelectorAll('button')].find((b) =>
      pattern.test(b.textContent ?? '')
    ) as HTMLButtonElement | undefined
  }

  beforeEach(async () => {
    document.body.replaceChildren()
    mock = installMockAuthenticator()
    await knownHome()
  })

  afterEach(() => {
    mock?.uninstall()
    mock = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('arms the next handshake with the bytes the box drew, and opens the home', async () => {
    const onPaired = vi.fn()
    render(Pair, { props: { onPaired } })

    const offer = await vi.waitFor(() => {
      const button = buttonSaying(/won't let this phone in/i)
      expect(button, 'the screen never offered a code to type').toBeDefined()
      return button!
    })
    offer.click()
    await vi.waitFor(() => expect(field()).toBeTruthy())

    // Read out as "zero four aitch em, ay ess double-u nine".
    type('04HM-ASW9')
    // The button opens only once eight characters are in hand. Clicking
    // before that lands on a disabled control and asserts nothing.
    const send = await vi.waitFor(() => {
      const button = buttonSaying(/^\s*Let this phone in\s*$/)!
      expect(button.disabled, 'a full code left the button shut').toBe(false)
      return button
    })
    send.click()

    await vi.waitFor(() => expect(onPaired).toHaveBeenCalledWith({ siteId: SITE }))

    // 0x01 0x23 0x45 0x67 0x89 at the box, from its own encoder. Message 1 of
    // the next handshake carries exactly this.
    const row = await (await db()).get('sites', SITE)
    expect([...row!.pairingCode!]).toEqual([0x01, 0x23, 0x45, 0x67, 0x89])
  })

  it('folds what a listener writes down, so a try is never spent on a mishearing', async () => {
    // Five wrong tries burn the code at the box. I for 1 and O for 0 is the
    // mistake this alphabet was chosen to absorb, and absorbing it has to
    // happen here — before anything reaches the wire.
    render(Pair, { props: { onPaired: vi.fn() } })

    const offer = await vi.waitFor(() => {
      const button = buttonSaying(/won't let this phone in/i)
      expect(button).toBeDefined()
      return button!
    })
    offer.click()
    await vi.waitFor(() => expect(field()).toBeTruthy())

    type('io1l0000')
    // What the field shows back is what will be sent: folded and grouped.
    expect(field().value).toBe('1011-0000')

    const send = await vi.waitFor(() => {
      const button = buttonSaying(/^\s*Let this phone in\s*$/)!
      expect(button.disabled).toBe(false)
      return button
    })
    send.click()
    await vi.waitFor(async () =>
      expect([...(await (await db()).get('sites', SITE))!.pairingCode!]).toEqual([
        0x08, 0x02, 0x10, 0x00, 0x00,
      ])
    )
  })

  it('will not send a code that is not eight characters yet', async () => {
    const onPaired = vi.fn()
    render(Pair, { props: { onPaired } })

    const offer = await vi.waitFor(() => {
      const button = buttonSaying(/won't let this phone in/i)
      expect(button).toBeDefined()
      return button!
    })
    offer.click()
    await vi.waitFor(() => expect(field()).toBeTruthy())

    type('04HM')
    await new Promise((r) => setTimeout(r, 30))
    const send = buttonSaying(/^\s*Let this phone in\s*$/)!
    expect(send.disabled, 'half a code opened the button').toBe(true)
    send.click()

    await new Promise((r) => setTimeout(r, 30))
    expect(onPaired, 'half a code was sent to the box').not.toHaveBeenCalled()
    expect((await (await db()).get('sites', SITE))!.pairingCode).toBeUndefined()
  })

  it('is not offered to a phone with no home to get back into', async () => {
    // A box code carries no box key and no rendezvous secret, so it can do
    // nothing for a phone that has never seen this box. The box's own page
    // says so rather than offering a path with no end; so does this.
    const database = await db()
    for (const row of await database.getAll('sites')) await database.delete('sites', row.siteId)

    render(Pair, { props: { onPaired: vi.fn() } })
    await new Promise((r) => setTimeout(r, 50))

    expect(buttonSaying(/won't let this phone in/i)).toBeUndefined()
  })
})

/* The first thing anyone sees, and the two questions it has to answer.
 *
 * Someone landing on app.ftw.energy is deciding two things at once: whether
 * to install, and which way in is theirs. The screen used to answer the
 * first with a strip at the foot of the app shown once per device, and the
 * second by making "scan" a button and "I've been here before" a line of
 * small text — which reads as one real way in and one afterthought.
 */
describe('arriving for the first time', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  function asIosSafariTab() {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      standalone: false,
      maxTouchPoints: 5,
    })
  }

  it('offers both ways in as the same size of choice', async () => {
    render(Pair, { props: { onPaired: vi.fn() } })

    // Both are buttons a thumb lands on, not one button and one hint. The
    // scan is only offered where a camera exists, so it is asserted through
    // whichever of the two this environment can draw.
    const before = await screen.findByRole('button', { name: /i've set this up before/i })
    expect(before).toBeTruthy()

    // And neither is dressed as the recommended one: the accent-filled
    // primary belongs to a single obvious action, and here there is none.
    expect(before.className).not.toMatch(/primary/)
  })

  it('says how to install, where someone lands rather than at the foot of the app', async () => {
    asIosSafariTab()
    render(Pair, { props: { onPaired: vi.fn() } })

    const said = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(said, 'no install instruction on the screen someone arrives at').toMatch(
      /add ftw to your home screen/i
    )
    // The two taps, named — iOS gives a page no way to open the Share sheet,
    // so naming them is the whole of what can honestly be done.
    expect(said).toMatch(/share/i)
    expect(said).toMatch(/add to home screen/i)
    // And why, in terms of what the person gets rather than storage policy.
    expect(said).toMatch(/notify|instantly|between visits/i)
  })

  it('says nothing about installing to a phone that already did', async () => {
    // Standalone: the app is on the home screen, so the instruction would be
    // telling someone to do a thing they have done.
    vi.stubGlobal('navigator', { ...navigator, standalone: true, maxTouchPoints: 5 })
    render(Pair, { props: { onPaired: vi.fn() } })

    expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).not.toMatch(
      /add to home screen/i
    )
  })
})
