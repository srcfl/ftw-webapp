import { describe, expect, it } from 'vitest'
import { timeZoneToOffer } from './time-zone-offer'

const owner = new Set(['ftw.live.read', 'ftw.setup.write'])

describe('the time zone a device offers its box', () => {
  it('offers the device zone to a box on UTC', () => {
    expect(timeZoneToOffer('UTC', 'Europe/Stockholm', owner)).toBe('Europe/Stockholm')
    expect(timeZoneToOffer('Etc/UTC', 'Europe/Stockholm', owner)).toBe('Europe/Stockholm')
  })

  it('offers nothing to a box that names a zone of its own', () => {
    expect(timeZoneToOffer('Europe/Stockholm', 'America/New_York', owner)).toBeNull()
  })

  it('offers nothing from a device that is itself on UTC', () => {
    expect(timeZoneToOffer('UTC', 'UTC', owner)).toBeNull()
    expect(timeZoneToOffer('UTC', null, owner)).toBeNull()
  })

  it('offers nothing from a device that may not change setup', () => {
    expect(timeZoneToOffer('UTC', 'Europe/Stockholm', new Set(['ftw.live.read']))).toBeNull()
  })
})
