import { describe, it, expect } from 'vitest'
import { fragmentTarget } from './landing'
import { siteIdFor } from './pairing'
import { buildEnrollmentUrl } from './enrollment'

// The reload bug this guards against: after pairing, /p#… is the URL the
// browser reloads and restores — with a spent code. The judgement is what
// keeps an owner off the pairing screen of a house they are standing in.

const KEY_A = new Uint8Array(32).fill(7)
const KEY_B = new Uint8Array(32).fill(9)

function fragmentFor(boxKey: Uint8Array): string {
  const url = buildEnrollmentUrl({
    boxStaticPublic: boxKey,
    pairingCode: new Uint8Array(16).fill(1),
    rendezvousSecret: new Uint8Array(32).fill(2),
    lanHint: '192.168.1.40:8080',
  })
  return '#' + url.split('#')[1]
}

describe('fragmentTarget', () => {
  it('names the site a fragment points at, matching siteIdFor', async () => {
    const target = await fragmentTarget(fragmentFor(KEY_A))
    expect(target).toBe(await siteIdFor(KEY_A))
    expect(target).not.toBe(await siteIdFor(KEY_B))
  })

  it('returns null for garbage instead of throwing at the shell', async () => {
    expect(await fragmentTarget('#not-a-fragment')).toBeNull()
    expect(await fragmentTarget('')).toBeNull()
    expect(await fragmentTarget('#v2.short')).toBeNull()
  })
})
