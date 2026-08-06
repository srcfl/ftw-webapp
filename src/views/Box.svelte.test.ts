import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen } from '@testing-library/svelte'
import Box from './Box.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { db, type StoredSite } from '$lib/store/db'
import { deviceKey, localWrappingKey, openVaultStore } from '$lib/identity/vault'
import { leaveHome } from '$lib/state/leave'

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
})
