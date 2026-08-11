/* Signing out, through the app rather than through its parts.
 *
 * The order sign-out depends on is spread across three files — the screen
 * asks, the shell stops what is writing, the store clears the disk — so the
 * only place it can be tested honestly is where they meet. Both faults this
 * covers are invisible from any single one of them:
 *
 *   - the disk cleared while the session is still streaming, so a reading
 *     that lands mid-clear writes the home straight back;
 *   - the session torn down for a clear that then failed, leaving a house on
 *     screen that has quietly stopped moving under a message promising it
 *     still works.
 *
 * This runs against the development simulator, which is what a browser runs
 * in `npm run dev` — the same carrier, the same 1 Hz stream.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen, cleanup } from '@testing-library/svelte'
import App from './App.svelte'
import { db, type StoredSite } from '$lib/store/db'
import {
  deviceKey,
  isEnrolled,
  localWrappingKey,
  openVaultStore,
  resetIdentity,
} from '$lib/identity/vault'
import { CarrierBase, type Carrier, type CarrierStatus } from '$lib/carrier/carrier'
import { encodeFrame, LANE_CONTROL } from '$lib/protocol/frame'
import { SiteStore } from '$lib/state/site.svelte'
import { buildEnrollmentUrl } from '$lib/identity/enrollment'

// jsdom has no ResizeObserver, and the History chart measures its own box
// with one. Nothing below depends on the width it would report.
class QuietResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= QuietResizeObserver as unknown as typeof ResizeObserver

/* The relay, stubbed at the one seam the shell reaches it through.
 *
 * Not to make failing convenient: a test that opens a real socket passes or
 * fails on whatever the machine's network is doing that morning. Nothing
 * arriving is one screen whether the relay refused, the box is mid-update or
 * the phone is on a train, and that screen is what is under test below.
 *
 * The sign-out tests never reach this. They run on the simulator's reserved
 * id, which the shell feeds directly and never connects.
 *
 * `openCarrier` is how a test says something else happened. The floor tests
 * below hand it the real connectToSite, because what they are about is what
 * the disk holds — no key, no rendezvous secret — and the refusals that come
 * of it belong to that file rather than to a stub of it.
 */
const seam = vi.hoisted(() => ({
  openCarrier: null as null | ((siteId: string) => Promise<Carrier>),
}))

vi.mock('$lib/state/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/state/connect')>()
  return {
    ...actual,
    connectToSite: (siteId: string) =>
      seam.openCarrier
        ? seam.openCarrier(siteId)
        : Promise.reject(new Error('nothing answered')),
  }
})

function promiseGate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

/** A carrier whose owner and close can be observed without opening a socket. */
class TrackedCarrier extends CarrierBase implements Carrier {
  readonly kind = 'relay' as const
  readonly rttMs = null
  status: CarrierStatus = { phase: 'connecting' }
  attached = false
  closed = false

  send(): void {}

  override onFrame(handler: (frame: Uint8Array) => void): () => void {
    this.attached = true
    return super.onFrame(handler)
  }

  close(reason = 'closed by test'): void {
    if (this.closed) return
    this.closed = true
    this.status = { phase: 'closed', reason, retryable: false }
    this.emitStatus(this.status)
    this.clearHandlers()
  }
}

const SITE_ID = 'sim-0001'

/** Neither Node nor jsdom gives this environment a localStorage. */
function stubStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

/** Paint the house, then wait until it is actually streaming. */
async function houseOnScreen() {
  render(App)
  await screen.findByText(/Live via encrypted relay/i, undefined, { timeout: 4_000 })
}

/** Open the one screen that can leave, and answer the question it asks. */
async function confirmSignOut() {
  ;(await screen.findByRole('button', { name: /^box$/i })).click()
  ;(await screen.findByRole('button', { name: /^sign out$/i })).click()

  // The question, which has to be on screen before anything is cleared.
  await screen.findByText(/Sign out on this phone\?/i)
  ;(await screen.findByRole('button', { name: /^sign out$/i })).click()
}

/** iOS swiping the app away: the shell's last chance to persist. */
async function backgroundTheApp() {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  // The flush is a chain of awaits — sealing, then IndexedDB.
  await new Promise((r) => setTimeout(r, 50))
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
}

/** A paired phone, as the disk holds one. */
async function pairPhone(siteId: string) {
  const database = await db()
  const row: StoredSite = {
    siteId,
    label: 'Home',
    boxStaticKey: new Uint8Array(32).fill(7),
    rendezvousSecret: new Uint8Array(32).fill(9),
    addedAtMs: Date.UTC(2026, 6, 1),
    lastSeenAtMs: Date.now(),
  }
  await database.put('sites', row)

  const vault = openVaultStore()
  await deviceKey(vault, await localWrappingKey(vault))
  localStorage.setItem('ftw.site', siteId)
}

describe('the public demo', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', stubStorage())
    history.replaceState(null, '', '/?pairing')
    location.hash = ''
    const database = await db()
    for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
      await database.clear(store)
    }
  })

  afterEach(() => {
    cleanup()
    history.replaceState(null, '', '/')
    vi.restoreAllMocks()
  })

  it('runs all four tabs in memory and exits without touching pairing data', async () => {
    render(App)
    ;(await screen.findByRole('button', { name: /try the live demo/i }, { timeout: 4_000 })).click()

    await screen.findByText(/Live demo · simulated home/i, undefined, { timeout: 4_000 })
    expect(screen.getAllByRole('button', { name: /^(now|plan|history|box)$/i })).toHaveLength(4)
    expect(localStorage.getItem('ftw.site')).toBeNull()
    expect(globalThis.ftwSim, 'the public demo exposed the development control').toBeUndefined()

    ;(await screen.findByRole('button', { name: /^plan$/i })).click()
    await screen.findByText(/How your home is run/i, undefined, { timeout: 4_000 })

    ;(await screen.findByRole('button', { name: /^history$/i })).click()
    await screen.findByText(/Last 7 days/i, undefined, { timeout: 4_000 })

    ;(await screen.findByRole('button', { name: /^box$/i })).click()
    await screen.findByRole('heading', { name: /demo home/i }, { timeout: 4_000 })
    expect(screen.queryByRole('button', { name: /^sign out$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /turn on notifications/i })).toBeNull()

    ;(await screen.findByRole('button', { name: /^exit demo$/i })).click()
    await screen.findByRole('heading', { name: /connect ftw/i }, { timeout: 4_000 })

    const database = await db()
    expect(await database.getAll('sites')).toEqual([])
    expect(await database.getAll('snapshot')).toEqual([])
    expect(await database.getAll('tiles')).toEqual([])
    expect(localStorage.getItem('ftw.site')).toBeNull()
  })
})

describe('switching homes while the first carrier is still being built', () => {
  const HOME_A = 'home-a'

  beforeEach(async () => {
    vi.stubGlobal('localStorage', stubStorage())
    const database = await db()
    for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
      await database.clear(store)
    }
    await resetIdentity(openVaultStore())
    await pairPhone(HOME_A)

    const offered = buildEnrollmentUrl({
      boxStaticPublic: new Uint8Array(32).fill(8),
      pairingCode: new Uint8Array(16).fill(4),
      rendezvousSecret: new Uint8Array(32).fill(5),
      lanHint: '',
    })
    history.replaceState(null, '', `/p${new URL(offered).hash}`)
  })

  afterEach(() => {
    seam.openCarrier = null
    cleanup()
    history.replaceState(null, '', '/')
    vi.restoreAllMocks()
  })

  it('closes A when B resolves first and A resolves last', async () => {
    const pending = new Map<string, ReturnType<typeof promiseGate<Carrier>>>()
    seam.openCarrier = (siteId) => {
      const gate = promiseGate<Carrier>()
      pending.set(siteId, gate)
      return gate.promise
    }

    render(App)
    await vi.waitFor(() => expect(pending.has(HOME_A)).toBe(true), { timeout: 4_000 })

    await screen.findByRole('heading', { name: /connect to a different box/i }, { timeout: 4_000 })
    ;(await screen.findByRole('button', { name: /^connect [0-9a-f]{6}$/i })).click()

    await vi.waitFor(() => expect(pending.size).toBe(2), { timeout: 4_000 })
    const homeB = [...pending.keys()].find((id) => id !== HOME_A)
    expect(homeB).toBeDefined()

    const carrierB = new TrackedCarrier()
    pending.get(homeB!)!.resolve(carrierB)
    await vi.waitFor(() => expect(carrierB.attached).toBe(true))

    const carrierA = new TrackedCarrier()
    pending.get(HOME_A)!.resolve(carrierA)
    await vi.waitFor(() => expect(carrierA.closed).toBe(true))

    expect(carrierA.attached, 'A replaced B after the home switch').toBe(false)
    expect(carrierB.closed, 'discarding A closed the current B carrier').toBe(false)
  })
})

describe('signing out, from the phone', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', stubStorage())
    const database = await db()
    for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
      await database.clear(store)
    }
    await pairPhone(SITE_ID)
  })

  afterEach(() => {
    globalThis.ftwSim?.stop()
    cleanup()
    vi.restoreAllMocks()
  })

  it('routes visibility, page restore and network wake events to the link', async () => {
    const visibility = vi.spyOn(SiteStore.prototype, 'setVisible')
    const pageShown = vi.spyOn(SiteStore.prototype, 'pageShown')
    const networkOnline = vi.spyOn(SiteStore.prototype, 'networkOnline')
    await houseOnScreen()

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pageshow'))
    window.dispatchEvent(new Event('online'))

    expect(visibility.mock.calls.map(([visible]) => visible)).toEqual(
      expect.arrayContaining([false, true])
    )
    expect(pageShown).toHaveBeenCalledTimes(1)
    expect(networkOnline).toHaveBeenCalledTimes(1)
  })

  it('leaves nothing of the home behind, and comes back at pairing', async () => {
    await houseOnScreen()
    const database = await db()
    await vi.waitFor(async () => expect(await database.get('snapshot', SITE_ID)).toBeTruthy())

    await confirmSignOut()

    await screen.findByText(/Connect FTW/i, undefined, { timeout: 4_000 })
    expect(await database.get('sites', SITE_ID)).toBeUndefined()
    expect(await database.get('snapshot', SITE_ID)).toBeUndefined()
    expect(await isEnrolled(openVaultStore()), 'the key outlived the home it opens').toBe(false)
    expect(localStorage.getItem('ftw.site')).toBeNull()
  })

  it('is not undone by a reading that lands while the disk is being cleared', async () => {
    await houseOnScreen()
    const database = await db()
    await vi.waitFor(async () => expect(await database.get('snapshot', SITE_ID)).toBeTruthy())

    // The interruption, injected exactly where it does damage: the moment the
    // snapshot is cleared, the box sends another reading and the app is
    // backgrounded. On a phone this is one tap on Sign out followed by a
    // swipe up, and the clear is several awaits long — long enough that a
    // 1 Hz stream lands inside it often.
    const clear = database.clear.bind(database)
    vi.spyOn(database, 'clear').mockImplementation(async (store) => {
      await clear(store)
      if (store !== 'snapshot') return
      globalThis.ftwSim?.box.tick(1_000)
      await new Promise((r) => setTimeout(r, 300))
      await backgroundTheApp()
    })

    await confirmSignOut()
    await screen.findByText(/Connect FTW/i, undefined, { timeout: 4_000 })

    // A sealed reading of the household this phone has just left, under a
    // cache key minted on demand to replace the one that went with it.
    expect(
      await database.get('snapshot', SITE_ID),
      'the home was written back while it was being cleared'
    ).toBeUndefined()
  })

  it('puts the home back, live, when the disk will not let go of it', async () => {
    await houseOnScreen()
    const database = await db()

    // The disk refuses partway through: a quota failure, or storage the
    // browser has locked. The rows survive, so this phone is still paired.
    const clear = database.clear.bind(database)
    vi.spyOn(database, 'clear').mockImplementation(async (store) => {
      if (store === 'snapshot') await clear(store)
      else throw new Error('quota exceeded')
    })

    await confirmSignOut()

    await screen.findByText(/still on this phone and still works/i, undefined, { timeout: 4_000 })
    expect(screen.queryByText(/Connect FTW/i)).toBeNull()
    expect(await database.get('sites', SITE_ID)).toBeTruthy()

    // And the sentence on screen has to be true. Signing out stops the
    // session before it touches the disk, so a clear that fails leaves a home
    // nothing is feeding — "still works" would be a promise the app breaks as
    // it makes it. The home is picked up again from scratch: the band drops
    // its claim to be live, and earns it back a moment later.
    await vi.waitFor(() => expect(screen.queryByText(/Live via encrypted relay/i)).toBeNull(), {
      timeout: 4_000,
    })
    await screen.findByText(/Live via encrypted relay/i, undefined, { timeout: 4_000 })
    expect(localStorage.getItem('ftw.site'), 'the launch pointer went with the home').toBe(SITE_ID)
  })

  it('gives a kept view back to the restored store, not to the stopped one', async () => {
    // The other half of putting the home back. Views read the store once,
    // untracked on purpose, so a view kept across the failed leave holds the
    // one that was stopped for good — History sat mounted and never asked
    // the restored store anything, forty seconds past every retry window.
    // The failed path has to reset `seen` the way the successful one does.
    const askedHistory = vi.spyOn(SiteStore.prototype, 'history')

    await houseOnScreen()
    ;(await screen.findByRole('button', { name: /^history$/i })).click()
    await vi.waitFor(() => expect(askedHistory).toHaveBeenCalled(), { timeout: 4_000 })
    const oldStore = askedHistory.mock.contexts.at(-1)
    const before = askedHistory.mock.calls.length

    const database = await db()
    const clear = database.clear.bind(database)
    vi.spyOn(database, 'clear').mockImplementation(async (store) => {
      if (store === 'snapshot') await clear(store)
      else throw new Error('quota exceeded')
    })

    await confirmSignOut()
    // The failure is still said, by a screen that was itself remounted.
    await screen.findByText(/still on this phone and still works/i, undefined, { timeout: 4_000 })

    // Back to History, the way a person returns to it.
    ;(await screen.findByRole('button', { name: /^history$/i })).click()
    await vi.waitFor(
      () => {
        expect(
          askedHistory.mock.calls.length,
          'the restored store was never asked for a window'
        ).toBeGreaterThan(before)
        expect(
          askedHistory.mock.contexts.at(-1),
          'the ask went to the store that was stopped for good'
        ).not.toBe(oldStore)
      },
      { timeout: 4_000 }
    )
  })

  it('keeps one populated panel visible through first and rapid tab taps', async () => {
    await houseOnScreen()
    const visible = () =>
      [...document.querySelectorAll<HTMLElement>('.view')].filter((view) => !view.hidden)
    const expectOne = () => {
      expect(visible(), 'the shell showed zero or two panels').toHaveLength(1)
      expect(visible()[0]!.textContent?.trim(), 'the visible panel was empty').not.toBe('')
    }

    expectOne()
    ;(await screen.findByRole('button', { name: /^history$/i })).click()
    // The old panel stays until the first History chunk has loaded and the
    // target has mounted hidden. There is no empty promise branch to paint.
    expectOne()

    ;(await screen.findByRole('button', { name: /^box$/i })).click()
    await screen.findByText(/Your FTW box/i, undefined, { timeout: 4_000 })
    expectOne()
    expect(screen.getByRole('button', { name: /^box$/i }).getAttribute('aria-current')).toBe(
      'page'
    )
  })

  it('restores each tab scroll position', async () => {
    await houseOnScreen()
    const main = document.querySelector('main')!

    ;(await screen.findByRole('button', { name: /^history$/i })).click()
    await screen.findByText(/Last 7 days/i, undefined, { timeout: 4_000 })
    main.scrollTop = 355

    ;(await screen.findByRole('button', { name: /^now$/i })).click()
    await vi.waitFor(() => expect(main.scrollTop).toBe(0), { timeout: 4_000 })

    ;(await screen.findByRole('button', { name: /^history$/i })).click()
    await vi.waitFor(() => expect(main.scrollTop).toBe(355), { timeout: 4_000 })
  })
})

/* The state this whole screen was built for, and the one it used to get wrong.
 *
 * A phone that is paired, cannot reach its box and has nothing cached. Not a
 * corner: it is a phone indoors on a dead relay, a box mid-update, a first
 * launch away from home. Nothing has arrived from anywhere, so every reading
 * the shell judges "paired" by is missing — and the app said two opposite
 * things at once, one tab apart.
 *
 * A real box id, not the simulator's reserved one, so the app takes the relay
 * path and finds nothing at the end of it.
 */
const UNREACHABLE_ID = 'box-real'

describe('a paired phone that cannot reach its box', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', stubStorage())
    const database = await db()
    for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
      await database.clear(store)
    }
    await pairPhone(UNREACHABLE_ID)
  })

  afterEach(() => {
    globalThis.ftwSim?.stop()
    cleanup()
    vi.restoreAllMocks()
  })

  it('does not say the phone is unpaired on one tab and paired on the next', async () => {
    render(App)

    // The tab bar is the app's own answer to whether this phone has a home,
    // and it says yes — so no screen inside it may say no.
    const boxTab = await screen.findByRole('button', { name: /^box$/i }, { timeout: 4_000 })

    expect(
      screen.queryByText(/Nothing paired yet/i),
      'told a paired phone it has nothing paired'
    ).toBeNull()
    expect(screen.queryByText(/Scan the code shown on your FTW box/i)).toBeNull()

    // And one tap away, the screen whose job is to name the box names it —
    // off the disk, without reaching anything. Both are true at once, or the
    // app is arguing with itself in front of the person holding it.
    boxTab.click()
    await screen.findByText(/^[0-9A-F]{6}$/, undefined, { timeout: 4_000 })
    await screen.findByRole('button', { name: /^sign out$/i })
  })

  it('says what is happening instead of showing a house with nothing in it', async () => {
    render(App)
    await screen.findByRole('button', { name: /^box$/i }, { timeout: 4_000 })

    // Never a reading, never a claim to be live. What is left to say is what
    // this phone is doing about it, which is the only thing the person can
    // act on: nothing.
    const said = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')
    await vi.waitFor(() => expect(said()).toMatch(/Nothing from your box yet/i), { timeout: 4_000 })
    expect(said()).toMatch(/keeps trying on its own/i)
    expect(screen.queryByText(/Live via encrypted relay/i)).toBeNull()
  })
})

/* The floor, and reaching it from the states it is the floor for.
 *
 * Everything a person waits on in this app heals itself — a dropped carrier
 * reconnects, a failed ask is asked again, and the only sign is a freshness
 * stamp falling behind. See $lib/state/ask. These are the states where waiting
 * heals nothing, because there is no session to come back: no key for the
 * home, a key the box has stopped taking, a row pointing at a box that no
 * longer knows this phone. The screen that fixes all three is the pairing
 * screen — and it was mounted on one condition, "this phone has no home at
 * all", which is false for every phone in those states. The phone the floor
 * was built for was the one phone that could not stand on it.
 *
 * Each of these asserts two things: that the way back is on the screen the
 * person is looking at, and that what it leads to offers only the ways in that
 * can actually work from there. An offer with no end is what this app calls a
 * dead end with a button on it.
 */
describe('the way back, for a phone that cannot get in', () => {
  const HOME_ID = 'box-stranded'

  /** A carrier that opens and says nothing: a box that will not have us. */
  class SilentCarrier extends CarrierBase implements Carrier {
    readonly kind = 'relay' as const
    readonly rttMs = null
    readonly status: CarrierStatus = { phase: 'connecting' }
    send(): void {}
    close(): void {}

    /**
     * Whether the session is listening yet.
     *
     * The shell reaches a carrier one await after the first paint, so a frame
     * sent on the strength of what is on screen is a frame sent to nobody.
     */
    attached = false

    override onFrame(handler: (frame: Uint8Array) => void): () => void {
      this.attached = true
      return super.onFrame(handler)
    }

    /** The one refusal a box says out loud, rather than by going quiet. */
    revoke(): void {
      this.emitFrame(
        encodeFrame(
          {
            lane: LANE_CONTROL,
            flags: 0,
            envelope: { t: 'session.terminate', b: { reason: 'revoked' } },
          },
          1024
        )
      )
    }
  }

  const said = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

  function buttonSaying(pattern: RegExp): HTMLButtonElement | undefined {
    return [...document.querySelectorAll('button')].find((b) =>
      pattern.test((b.textContent ?? '').replace(/\s+/g, ' '))
    ) as HTMLButtonElement | undefined
  }

  /** The way back, as a person finds it: a button, on the screen they are on. */
  async function takeTheWayBack(pattern: RegExp): Promise<void> {
    const button = await vi.waitFor(
      () => {
        const found = buttonSaying(pattern)
        expect(found, 'no way back was offered at all').toBeDefined()
        return found!
      },
      { timeout: 4_000 }
    )
    button.click()
  }

  /** A home on the disk, with whatever this phone is missing left out. */
  async function homeOnDisk(opts: { key?: boolean; rendezvous?: boolean } = {}) {
    const database = await db()
    const row: StoredSite = {
      siteId: HOME_ID,
      label: 'Home',
      boxStaticKey: new Uint8Array(32).fill(7),
      ...(opts.rendezvous === false ? {} : { rendezvousSecret: new Uint8Array(32).fill(9) }),
      addedAtMs: Date.UTC(2026, 6, 1),
      lastSeenAtMs: Date.now(),
    }
    await database.put('sites', row)
    if (opts.key !== false) {
      const vault = openVaultStore()
      await deviceKey(vault, await localWrappingKey(vault))
    }
    localStorage.setItem('ftw.site', HOME_ID)
  }

  beforeEach(async () => {
    vi.stubGlobal('localStorage', stubStorage())
    // A launch, not the tab a test left open: the hash outlives a render, and
    // a Now view left hidden behind #/box is invisible to a role query for
    // reasons that have nothing to do with what is being measured.
    location.hash = ''
    const database = await db()
    for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
      await database.clear(store)
    }
    // The device key lives in its own database, `ftw-identity`, which the
    // clear above does not touch — so without this a phone meant to have no
    // key inherits one from the test before and opens a real relay socket.
    await resetIdentity(openVaultStore())
    // A phone has a camera. Without one the scan offer is correctly absent,
    // and these tests would be measuring jsdom rather than the screen.
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => ({}) },
      configurable: true,
    })
    // The real one. What is under test is what this app does with a disk in
    // these states, and the refusals are part of that.
    const { connectToSite } = await vi.importActual<typeof import('$lib/state/connect')>(
      '$lib/state/connect'
    )
    seam.openCarrier = (siteId) => connectToSite(siteId)
  })

  afterEach(() => {
    seam.openCarrier = null
    globalThis.ftwSim?.stop()
    cleanup()
    vi.restoreAllMocks()
  })

  it('reaches the pairing screen from a home this device has no key for', async () => {
    // The measured state: the identity database was evicted and the site row
    // was not. Every launch since has pointed at a home this phone cannot open.
    await homeOnDisk({ key: false })
    render(App)

    // The shell believes this phone has a home — that is the whole bug — and
    // the screen it shows says why it cannot open it.
    await screen.findByRole('button', { name: /^box$/i }, { timeout: 4_000 })
    await vi.waitFor(() => expect(said()).toMatch(/no key for that home/i), { timeout: 4_000 })

    await takeTheWayBack(/get this phone back in/i)

    // The two ways that work with no key: a new QR from the box dashboard and the
    // sealed copy a passkey opens.
    await screen.findByRole('button', { name: /scan the pairing qr/i }, { timeout: 4_000 })
    expect(buttonSaying(/open with your passkey/i), 'the sealed copy was not offered').toBeDefined()
  })

  it('does not say it is reaching a box it can never reach', async () => {
    // "Reaching your box" is true for the first second of every launch, which
    // is why it is the opening line. It is not true when no carrier could be
    // built at all: nothing is in flight, nothing is retrying, and the screen
    // under the band says as much. Two sentences, one screen, one of them a
    // lie is the fault this whole block is about, one element higher.
    await homeOnDisk({ key: false })
    render(App)
    await vi.waitFor(() => expect(said()).toMatch(/no key for that home/i), { timeout: 4_000 })

    const band = await screen.findByRole('status')
    await vi.waitFor(() => expect(band.textContent).toMatch(/Can't reach your box/i), {
      timeout: 4_000,
    })
    expect(band.textContent, 'the band claimed to be reaching a box it has no key for').not.toMatch(
      /Reaching your box/i
    )
  })

  it('offers no typed code to a phone with no key to let in', async () => {
    // Eight characters carry no box key and no device key. Typed by a phone
    // whose vault is empty they write a code no handshake can ever spend —
    // a path with no end, which is what the box's own page refuses to offer.
    await homeOnDisk({ key: false })
    render(App)
    await vi.waitFor(() => expect(said()).toMatch(/no key for that home/i), { timeout: 4_000 })
    await takeTheWayBack(/get this phone back in/i)
    await screen.findByRole('button', { name: /scan the pairing qr/i }, { timeout: 4_000 })

    expect(buttonSaying(/scan a new pairing qr/i)).toBeUndefined()
    expect(buttonSaying(/^\s*Open Home\s*$/), 'offered to open a home it holds no key for').toBeUndefined()
  })

  it('reaches it from a box that has stopped taking this key, while still trying', async () => {
    // A revoked phone, or a box that was reset and no longer knows this one.
    // It answers a refused handshake with silence, on purpose, so this is what
    // a phone in that state sees: nothing, for as long as it is left there.
    await homeOnDisk()
    seam.openCarrier = async () => new SilentCarrier()
    render(App)

    await vi.waitFor(() => expect(said()).toMatch(/Nothing from your box yet/i), { timeout: 4_000 })
    // The offer does not replace the healing. The app keeps trying; the person
    // is simply no longer the only one of the two who cannot act.
    expect(said()).toMatch(/keeps trying on its own/i)

    await takeTheWayBack(/won't let this phone in/i)
    await screen.findByText(/Welcome back/i, undefined, { timeout: 4_000 })

    // A passkey copy would put back the same key the box refused. The current
    // box offers a fresh Settings QR, not a spoken code.
    expect(buttonSaying(/open with your passkey/i), 'offered a copy of the key it was refused for').toBeUndefined()
    expect(buttonSaying(/scan a new pairing qr/i)).toBeDefined()
    expect(document.querySelector('input')).toBeNull()
  })

  it('reaches it from a box that has withdrawn this phone out loud', async () => {
    // The one refusal that is not silence. The session ends where it stands
    // and nothing reconnects it, so this screen is where a revoked phone sits
    // until somebody at the box shows it a code.
    await homeOnDisk()
    const box = new SilentCarrier()
    seam.openCarrier = async () => box
    render(App)
    await vi.waitFor(() => expect(said()).toMatch(/Nothing from your box yet/i), { timeout: 4_000 })
    await vi.waitFor(() => expect(box.attached).toBe(true), { timeout: 4_000 })

    box.revoke()
    // The band says it too, from the same state. The heading is this screen's.
    await screen.findByRole('heading', { name: /Access ended/i }, { timeout: 4_000 })

    await takeTheWayBack(/won't let this phone in/i)
    await screen.findByText(/Welcome back/i, undefined, { timeout: 4_000 })
  })

  it('reaches it from a row that cannot find its box at all', async () => {
    // Paired before the rendezvous secret existed, so this phone cannot derive
    // a handle and there is nothing to connect to. Only a fresh scan or the
    // sealed copy carries the missing bytes.
    await homeOnDisk({ rendezvous: false })
    render(App)

    await vi.waitFor(() => expect(said()).toMatch(/before this app could reach it privately/i), {
      timeout: 4_000,
    })
    await takeTheWayBack(/get this phone back in/i)
    await screen.findByRole('button', { name: /scan the pairing qr/i }, { timeout: 4_000 })

    expect(
      buttonSaying(/^\s*Open Home\s*$/),
      'offered to open a home it cannot reach, which lands straight back here'
    ).toBeUndefined()
    expect(buttonSaying(/scan a new pairing qr/i)).toBeUndefined()
    expect(buttonSaying(/open with your passkey/i)).toBeDefined()
  })

  it('is a way back and not another dead end', async () => {
    // Somebody who opens it and changes their mind gets their home back —
    // cached readings, tab bar and all. A screen with no way out of it is the
    // fault this whole block is about, one screen further along.
    await homeOnDisk({ key: false })
    render(App)
    await vi.waitFor(() => expect(said()).toMatch(/no key for that home/i), { timeout: 4_000 })
    await takeTheWayBack(/get this phone back in/i)
    await screen.findByRole('button', { name: /scan the pairing qr/i }, { timeout: 4_000 })

    buttonSaying(/^\s*Not now\s*$/)!.click()
    await screen.findByRole('button', { name: /^box$/i }, { timeout: 4_000 })
    expect(said()).toMatch(/no key for that home/i)
  })
})
