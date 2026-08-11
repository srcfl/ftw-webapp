/* Spending a code read off the box.
 *
 * The box mints eight characters, shows them on its own page and tells the
 * household to read them out. What arrives here is what somebody typed; what
 * has to leave is the five bytes the box drew, in the field the next Noise
 * handshake already carries.
 *
 * Two rules, and both are about the failure counter at the box: five wrong
 * tries burn the code, so nothing may reach the disk — and from there the
 * wire — that this app could have read correctly itself, and nothing may be
 * written at all for a code that cannot be a code.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { redeemBoxCode } from './pairing'
import { db, type StoredSite } from '$lib/store/db'

const SITE = 'aaaabbbbccccdddd'

async function siteRow(): Promise<StoredSite | undefined> {
  return (await db()).get('sites', SITE)
}

beforeEach(async () => {
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
})

describe('a box code, redeemed', () => {
  it('arms the next handshake with the bytes the box drew', async () => {
    // 04HM-ASW9 is 0x01 0x23 0x45 0x67 0x89 at the box — from its own encoder.
    await redeemBoxCode(SITE, '04HM-ASW9')

    expect([...(await siteRow())!.pairingCode!]).toEqual([0x01, 0x23, 0x45, 0x67, 0x89])
  })

  it('reads a listener’s I and O as the box’s 1 and 0, without spending a try', async () => {
    // The one case the alphabet exists for: somebody wrote down what they
    // heard. Sending these eight characters unfolded would be one of five
    // tries gone on a code that was read out correctly.
    await redeemBoxCode(SITE, 'io1l-0000')

    expect([...(await siteRow())!.pairingCode!]).toEqual([0x08, 0x02, 0x10, 0x00, 0x00])
  })

  it('keeps everything else about the home', async () => {
    await redeemBoxCode(SITE, '04HM-ASW9')

    const row = (await siteRow())!
    // The box key is the trust anchor and the rendezvous secret is how this
    // phone finds the box at all. A code that replaced the row rather than
    // arming it would leave a home nothing can reach.
    expect([...row.boxStaticKey]).toEqual([...new Uint8Array(32).fill(7)])
    expect([...row.rendezvousSecret!]).toEqual([...new Uint8Array(32).fill(9)])
    expect(row.label).toBe('Home')
  })

  it('writes nothing for something that is not a code', async () => {
    await expect(redeemBoxCode(SITE, 'UUUU-UUUU')).rejects.toThrow()

    expect((await siteRow())!.pairingCode, 'a bad code still armed a handshake').toBeUndefined()
  })

  it('refuses a home this phone has no record of, and says what to do', async () => {
    // A box code carries no box key and no rendezvous secret. A phone with no
    // row could not find the box or be sure of the one that answered, so this
    // is a dead end rather than a slow failure — and the sentence says scan.
    await expect(redeemBoxCode('nosuchsite', '04HM-ASW9')).rejects.toMatchObject({
      help: expect.stringMatching(/settings → ftw app → show pairing code/i),
    })
  })
})
