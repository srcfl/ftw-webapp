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

    expect(screen.getByRole('button', { name: /open with your passkey/i })).toBeTruthy()
    expect(mock.getCalls, 'the pairing screen opened a passkey sheet on arrival').toBe(0)
    expect(asked, 'the pairing screen reached for a copy nobody asked for').not.toHaveBeenCalled()
  })

  it('says there is nothing saved, rather than showing a fault', async () => {
    // A save can fail or a platform can lack a recovery key. That is not a
    // pairing fault.
    mock = installMockAuthenticator()
    // A passkey that exists and has never escrowed anything. Without one the
    // authenticator answers NotAllowedError — the same DOMException a
    // dismissed sheet gives — and no platform tells those two apart, so the
    // screen stays quiet, which is what a dismissal has to do.
    await enrollWrappingKey(memoryVaultStore())
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))

    render(Pair, { props: { onPaired: vi.fn() } })
    ;(await screen.findByRole('button', { name: /open with your passkey/i })).click()

    await vi.waitFor(() =>
      expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toMatch(
        /Nothing was saved for this passkey/i
      )
    )
    // Still on the screen it started on, with the scan still offered.
    expect(screen.getByRole('button', { name: /open with your passkey/i })).toBeTruthy()
  })

  it('offers a way back when the passkey ceremony stalls', async () => {
    mock = installMockAuthenticator()
    // A ceremony that never answers: no sheet ever came and the promise
    // never settles. The screen must still have an exit that is not the OS.
    Object.defineProperty(navigator, 'credentials', {
      value: { get: () => new Promise(() => {}) },
      configurable: true,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))

    render(Pair, { props: { onPaired: vi.fn() } })
    ;(await screen.findByRole('button', { name: /open with your passkey/i })).click()

    expect(await screen.findByRole('heading', { name: /checking/i })).toBeTruthy()
    ;(await screen.findByRole('button', { name: /cancel/i })).click()
    // Back where it started, with every way in offered again.
    expect(await screen.findByRole('button', { name: /open with your passkey/i })).toBeTruthy()
  })
})

/* A phone that still has its home can either open it or scan a fresh QR.
 *
 * The current box UI shows no spoken eight-character code. Keeping that path
 * in the app taught people to look for a control that does not exist.
 */
describe('a home already saved on this phone', () => {
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

  beforeEach(async () => {
    document.body.replaceChildren()
    mock = installMockAuthenticator()
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => ({}) },
      configurable: true,
    })
    await knownHome()
  })

  afterEach(() => {
    mock?.uninstall()
    mock = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('offers the saved home and a fresh Settings QR, never a typed code', async () => {
    const onPaired = vi.fn()
    render(Pair, { props: { onPaired } })

    expect(await screen.findByRole('button', { name: /^open home$/i })).toBeTruthy()
    expect(await screen.findByRole('button', { name: /scan a new pairing qr/i })).toBeTruthy()
    expect(document.querySelector('input')).toBeNull()
    expect(document.body.textContent).not.toMatch(/eight characters|type the code/i)
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
  beforeEach(async () => {
    document.body.replaceChildren()
    const database = await db()
    for (const row of await database.getAll('sites')) await database.delete('sites', row.siteId)
  })

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
      // Make Scan a real option in this test environment. Its absence below
      // must come from the install gate, not from jsdom having no camera.
      mediaDevices: { getUserMedia: vi.fn() },
    })
  }

  it('names the exact local dashboard path and the conditional recovery path', async () => {
    render(Pair, { props: { onPaired: vi.fn() } })

    const said = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toMatch(/local FTW dashboard/i)
    expect(said).toMatch(/Settings → FTW app/i)
    expect(said).toMatch(/Show pairing code/i)
    expect(said).toMatch(/not printed on the Raspberry Pi/i)
    expect(screen.getByRole('button', { name: /open with your passkey/i })).toBeTruthy()
    expect(said).toMatch(/sealed recovery copy/i)
    expect(said).toMatch(/If that passkey supports recovery and the save reaches Sourceful/i)
    expect(said).toMatch(/If not, pairing still works; a new Settings QR is the way back/i)
    expect(said).not.toMatch(/FTW also saves a sealed recovery copy/i)
  })

  it('starts a demo only after the person asks', async () => {
    const onTryDemo = vi.fn(async () => {})
    const onPaired = vi.fn()
    render(Pair, { props: { onPaired, onTryDemo } })

    expect(onTryDemo).not.toHaveBeenCalled()
    ;(await screen.findByRole('button', { name: /try the live demo/i })).click()
    await vi.waitFor(() => expect(onTryDemo).toHaveBeenCalledOnce())
    expect(onPaired).not.toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: /starting the demo/i })).toBeTruthy()
  })

  it('does not offer the public demo from a recovery screen', async () => {
    render(Pair, {
      props: {
        onPaired: vi.fn(),
        onTryDemo: vi.fn(),
        problem: 'This phone has no key for that home.',
        dismiss: vi.fn(),
      },
    })

    expect(screen.queryByRole('button', { name: /try the live demo/i })).toBeNull()
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
    expect(screen.queryByRole('button', { name: /open with your passkey/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /scan the pairing qr/i })).toBeNull()
  })

  it('keeps an incoming QR inactive in Safari until the app is installed', async () => {
    asIosSafariTab()
    render(Pair, {
      props: { fragment: fragmentFor(ATTACKER_KEY), onPaired: vi.fn() },
    })

    expect(await screen.findByRole('heading', { name: /install ftw first/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /connect this box/i })).toBeNull()
    expect(await screen.findByText(/scan the pairing QR again/i)).toBeTruthy()
  })

  it('keeps an invalid pairing link behind the Safari install gate', async () => {
    asIosSafariTab()
    const onPaired = vi.fn()
    render(Pair, {
      props: { fragment: '#not-a-pairing-code', onPaired },
    })

    expect(await screen.findByText(/not an FTW pairing code/i)).toBeTruthy()
    expect(screen.getByRole('heading', { name: /install ftw first/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /scan the pairing qr/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /open with your passkey/i })).toBeNull()
    expect(onPaired).not.toHaveBeenCalled()
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
