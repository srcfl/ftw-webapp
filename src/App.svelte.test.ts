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
import { deviceKey, isEnrolled, localWrappingKey, openVaultStore } from '$lib/identity/vault'

/* The relay, stubbed at the one seam the shell reaches it through.
 *
 * Not to make failing convenient: a test that opens a real socket passes or
 * fails on whatever the machine's network is doing that morning. Nothing
 * arriving is one screen whether the relay refused, the box is mid-update or
 * the phone is on a train, and that screen is what is under test below.
 *
 * The sign-out tests never reach this. They run on the simulator's reserved
 * id, which the shell feeds directly and never connects.
 */
vi.mock('$lib/state/connect', () => ({
  connectToSite: () => Promise.reject(new Error('nothing answered')),
}))

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

  it('leaves nothing of the home behind, and comes back at pairing', async () => {
    await houseOnScreen()
    const database = await db()
    await vi.waitFor(async () => expect(await database.get('snapshot', SITE_ID)).toBeTruthy())

    await confirmSignOut()

    await screen.findByText(/Connect your box/i, undefined, { timeout: 4_000 })
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
    await screen.findByText(/Connect your box/i, undefined, { timeout: 4_000 })

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
    expect(screen.queryByText(/Connect your box/i)).toBeNull()
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
