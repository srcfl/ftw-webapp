import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen } from '@testing-library/svelte'
import Box from './Box.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { db, type StoredSite } from '$lib/store/db'
import {
  deviceKey,
  enrollWrappingKey,
  localWrappingKey,
  openVaultStore,
} from '$lib/identity/vault'
import { leaveHome } from '$lib/state/leave'
import { installMockAuthenticator, type MockAuthenticator } from '../../tests/support/passkey'

/* Signing out is destructive on this device and needs the physical QR code to
 * undo. So it asks first — and asking is not decoration: a single stray tap
 * that cleared the vault would cost a trip to wherever the box is mounted.
 *
 * What this screen owns is the question and the two answers to it. The order
 * behind the door — stop what is writing, then clear — belongs to the shell,
 * and is tested where it lives, in App.svelte.test.ts.
 */

const SITE_ID = 'sim-0001'
const BOX_KEY = new Uint8Array(32).fill(7)

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

async function pairedRow(): Promise<StoredSite> {
  const row: StoredSite = {
    siteId: SITE_ID,
    label: 'Home',
    boxStaticKey: BOX_KEY,
    rendezvousSecret: new Uint8Array(32).fill(9),
    addedAtMs: Date.UTC(2026, 7, 5),
    lastSeenAtMs: Date.now(),
  }
  const database = await db()
  await database.put('sites', row)
  return row
}

function mounted() {
  const site = new SiteStore('test')
  void site.start(SITE_ID)
  // The shell's leave, as the shell supplies it: real, so "it cleared the
  // home" is a fact about the disk and not about a spy being called.
  const left = vi.fn(() => leaveHome({ home: site }))
  render(Box, { props: { site, leave: left } })
  return { site, left }
}

describe('leaving, from the phone', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', stubStorage())
    const database = await db()
    for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
      await database.clear(store)
    }
    await pairedRow()
    // A paired phone always has one, and it is what the box lists it by.
    const vault = openVaultStore()
    await deviceKey(vault, await localWrappingKey(vault))
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('names the box it is paired to, without needing to reach it', async () => {
    mounted()

    // The box software and the web app are two releases. Showing the latter's
    // build id is how a screenshot can prove which deployed client is open.
    expect(screen.getByText('Web app')).toBeTruthy()
    expect(screen.getByText(__APP_BUILD__)).toBeTruthy()

    // Nothing here connects. The box has to be nameable precisely when it is
    // out of reach, because that is one of the reasons someone opens this.
    const fingerprint = await screen.findByText(/^[0-9A-F]{6}$/)
    expect(fingerprint).toBeTruthy()

    // And the row this phone is on the box's own list, so the other half of
    // leaving can actually be carried out.
    expect(await screen.findByText(/This phone/)).toBeTruthy()
  })

  it('names no box at all rather than the wrong one', async () => {
    // The rows on this phone do not include the one it is pointed at: a row
    // cleared by an interrupted sign-out, or an id that moved on. Falling back
    // to whichever row comes first put another box's name on the screen, with
    // another box's pairing date under it — on the one screen whose whole job
    // is saying which box this is.
    const database = await db()
    await database.clear('sites')
    await database.put('sites', {
      siteId: 'someone-elses-box',
      label: 'Other',
      boxStaticKey: new Uint8Array(32).fill(3),
      rendezvousSecret: new Uint8Array(32).fill(4),
      addedAtMs: Date.UTC(2024, 0, 9),
      lastSeenAtMs: Date.now(),
    })

    mounted()
    // Long enough for the reads behind the name to finish and paint.
    await vi.waitFor(() => expect(screen.getByText(/This phone/)).toBeTruthy())

    expect(
      screen.queryByText(/^[0-9A-F]{6}$/),
      'named a box this phone is not paired to'
    ).toBeNull()
    const said = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(said, 'dated this pairing from another one').not.toMatch(/Paired/)
  })

  it('asks before it clears anything', async () => {
    const { left } = mounted()

    const open = await screen.findByRole('button', { name: /^sign out$/i })
    open.click()
    await new Promise((r) => setTimeout(r, 20))

    expect(left, 'one tap signed the phone out').not.toHaveBeenCalled()
    const database = await db()
    expect(await database.get('sites', SITE_ID), 'one tap cleared the home').toBeTruthy()

    // And it says which half it is doing: this phone, not the box's list.
    // Collapsed, because where the prose wraps is not what is being tested.
    const said = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toMatch(/Nothing is removed from your box/i)
    // And where the other half is carried out. The box's settings has a tab
    // called "FTW app"; naming it is the difference between a sentence and
    // an instruction.
    expect(said).toMatch(/remove it there too: Settings, then FTW app/i)
    // With the id to look for, and no promise that it is on the list: a key
    // that never finished pairing was never recorded, and one removed on the
    // box already is gone. base64url, so the id can carry '-' and '_' as well
    // as \w — a device whose key happened to start with one used to fail this
    // about one run in five.
    expect(said).toMatch(/looking for [\w-]{8}\./i)
    expect(said, 'promised a list this app cannot see').not.toMatch(/will still list/i)
  })

  it('clears the home once it is confirmed, and says the app can go back', async () => {
    const { left } = mounted()

    const open = await screen.findByRole('button', { name: /^sign out$/i })
    open.click()
    await new Promise((r) => setTimeout(r, 20))

    // The confirm button, which is the second one to carry this name.
    const confirm = screen.getAllByRole('button', { name: /^sign out$/i }).at(-1)!
    confirm.click()
    await vi.waitFor(() => expect(left).toHaveBeenCalled())

    const database = await db()
    await vi.waitFor(async () => expect(await database.get('sites', SITE_ID)).toBeUndefined())
  })

  it('says the home is still here when clearing it did not finish', async () => {
    const database = await db()
    vi.spyOn(database, 'clear').mockRejectedValue(new Error('quota exceeded'))
    const { left } = mounted()

    ;(await screen.findByRole('button', { name: /^sign out$/i })).click()
    await new Promise((r) => setTimeout(r, 20))
    screen.getAllByRole('button', { name: /^sign out$/i }).at(-1)!.click()

    // Never the pairing screen for a home that is still on the disk.
    await vi.waitFor(() =>
      expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toMatch(
        /still on this phone and still works/i
      )
    )
    expect(left).toHaveBeenCalled()
    const stillThere = await database.get('sites', SITE_ID)
    expect(stillThere, 'the home this screen says is still here').toBeTruthy()
  })

  it('opens on the unfinished sign-out when the shell says so', async () => {
    // A failed leave tears this screen down with every other view when the
    // shell puts the home back, so the instance that met the failure — and
    // held it in local state — is gone. The shell's word is what keeps the
    // sentence on screen instead of a Sign out button pretending nothing
    // happened.
    const site = new SiteStore('test')
    void site.start(SITE_ID)
    render(Box, { props: { site, leave: vi.fn(async () => {}), stuck: true } })

    const said = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')
    await vi.waitFor(() => expect(said()).toMatch(/That didn.t finish/i))
    expect(said()).toMatch(/still on this phone and still works/i)
  })
})

/* The spare key, and what it costs.
 *
 * This is the one thing on this screen that can be turned on, so the two
 * things worth pinning are that it says what it is in the words Sourceful is
 * held to, and that it does nothing whatever until someone asks. A screen that
 * quietly uploads a sealed copy is the same defect as a link that quietly
 * pairs, and it is harder to notice.
 */
describe('the sealed copy Sourceful can hold', () => {
  let mock: MockAuthenticator | null = null
  let calls: string[]
  let sent: unknown[]

  beforeEach(async () => {
    vi.stubGlobal('localStorage', stubStorage())
    const database = await db()
    for (const store of ['sites', 'snapshot', 'tiles', 'meta', 'keys'] as const) {
      await database.clear(store)
    }
    await pairedRow()
    calls = []
    sent = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        calls.push('fetch')
        sent.push(JSON.parse(String(init.body)))
        // Nothing held. Enough for both "write the first copy" and "there is
        // nothing to empty"; what the service does with it is proved in
        // escrow/src/escrow.test.ts.
        return new Response(JSON.stringify({}), { status: 404 })
      })
    )
  })

  afterEach(() => {
    mock?.uninstall()
    mock = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function enrolledWithPasskey(): Promise<void> {
    mock = installMockAuthenticator()
    const vault = openVaultStore()
    await deviceKey(vault, await enrollWrappingKey(vault))
  }

  it('says what Sourceful would hold, in the words it is held to', async () => {
    await enrolledWithPasskey()
    mounted()

    const said = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /keep a sealed copy/i })).toBeTruthy()
    )
    // The product's sentence, word for word.
    expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toContain(
      'sealed copy it cannot open, with an opaque id and nothing beside it'
    )
    // And what it costs, on the same screen and before the button — the trade
    // is the passkey becoming enough on its own, and a screen that names only
    // the benefit is the defect this project makes most often.
    expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toMatch(
      /your passkey is then enough to open this home/i
    )
    expect(said).not.toMatch(/we cannot ever/i)
  })

  it('holds nothing, and asks nothing, until someone taps', async () => {
    await enrolledWithPasskey()
    const before = mock!.getCalls
    mounted()
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /keep a sealed copy/i })).toBeTruthy()
    )
    await new Promise((r) => setTimeout(r, 20))

    expect(calls, 'the screen uploaded a copy nobody asked for').toEqual([])
    expect(mock!.getCalls, 'the screen opened a passkey sheet on its own').toBe(before)
    const database = await db()
    expect((await database.get('sites', SITE_ID))?.escrow).toBeUndefined()
  })

  it('signs out with no prompt and no request when nobody asked for a copy', async () => {
    // The whole cost of never opting in, on the screen where it would show.
    await enrolledWithPasskey()
    const { left } = mounted()
    const before = mock!.getCalls

    ;(await screen.findByRole('button', { name: /^sign out$/i })).click()
    await new Promise((r) => setTimeout(r, 20))
    screen.getAllByRole('button', { name: /^sign out$/i }).at(-1)!.click()
    await vi.waitFor(() => expect(left).toHaveBeenCalled())

    expect(mock!.getCalls, 'signing out asked for a passkey it did not need').toBe(before)
    expect(calls, 'signing out reached for a copy that was never made').toEqual([])
  })

  it('leaves the sealed copy where it is, and never reaches for it', async () => {
    // The change Fredrik asked for. A sign-out is this phone forgetting its
    // key, not deleting the way back: the copy is locked to the passkey, so
    // keeping it lets its owner return and hands nothing to anyone else.
    // Removing it is the switch above, its own deliberate act.
    await enrolledWithPasskey()
    const database = await db()
    const row = (await database.get('sites', SITE_ID)) as StoredSite
    await database.put('sites', { ...row, escrow: true })

    const site = new SiteStore('test')
    void site.start(SITE_ID)
    const left = vi.fn(async () => {
      calls.push('leave')
      await leaveHome({ home: site })
    })
    render(Box, { props: { site, leave: left } })

    ;(await screen.findByRole('button', { name: /^sign out$/i })).click()
    await new Promise((r) => setTimeout(r, 20))
    // The confirmation tells the truth: the copy stays, the passkey brings it
    // back, and removing it is the switch above.
    const said = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toMatch(/sealed copy stays/i)
    expect(said).not.toMatch(/emptied first/i)

    screen.getAllByRole('button', { name: /^sign out$/i }).at(-1)!.click()
    await vi.waitFor(() => expect(left).toHaveBeenCalled())

    // The escrow was never touched — no request left the phone.
    expect(calls, 'signing out reached for the sealed copy it must not touch').toEqual(['leave'])
  })

  it('signs out even when the escrow could not be reached, because it never tries', async () => {
    // The old flow blocked a sign-out on emptying the copy, so an offline
    // phone could not leave. Now the copy is not in the path at all: the
    // sign-out completes whatever the network is doing.
    await enrolledWithPasskey()
    const database = await db()
    const row = (await database.get('sites', SITE_ID)) as StoredSite
    await database.put('sites', { ...row, escrow: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline')
      })
    )
    const { left } = mounted()

    ;(await screen.findByRole('button', { name: /^sign out$/i })).click()
    await new Promise((r) => setTimeout(r, 20))
    screen.getAllByRole('button', { name: /^sign out$/i }).at(-1)!.click()

    await vi.waitFor(() => expect(left).toHaveBeenCalled())
    // No fetch was ever attempted — the escrow is not in the sign-out path.
    expect(calls, 'an offline sign-out still reached for the copy').toEqual([])
  })
})
