import { describe, expect, it } from 'vitest'
import { CLOUD_URL, RELAY_URL, resolveCarrier } from './origin'

describe('resolveCarrier', () => {
  it('keeps the relay when nothing asks for the cloud', () => {
    expect(resolveCarrier()).toEqual({ name: 'relay', url: RELAY_URL })
    expect(resolveCarrier({ carrier: 'relay' })).toEqual({ name: 'relay', url: RELAY_URL })
    expect(resolveCarrier({ carrier: '' }).fallbackUrl).toBeUndefined()
  })

  it('honours a relay override without growing a fallback', () => {
    expect(resolveCarrier({ relayUrl: 'ws://127.0.0.1:8787/' })).toEqual({
      name: 'relay',
      url: 'ws://127.0.0.1:8787',
    })
  })

  it('prefers the cloud and keeps the relay as the one fallback', () => {
    expect(resolveCarrier({ carrier: 'cloud' })).toEqual({
      name: 'cloud',
      url: CLOUD_URL,
      fallbackUrl: RELAY_URL,
    })
  })

  it('lets a build name both hosts', () => {
    expect(
      resolveCarrier({
        carrier: 'cloud',
        cloudUrl: 'wss://cloud.example/v1/',
        relayUrl: 'wss://relay.example',
      })
    ).toEqual({
      name: 'cloud',
      url: 'wss://cloud.example/v1',
      fallbackUrl: 'wss://relay.example',
    })
  })

  it('does not fall back onto the same origin', () => {
    expect(resolveCarrier({ carrier: 'cloud', cloudUrl: RELAY_URL, relayUrl: RELAY_URL })).toEqual({
      name: 'relay',
      url: RELAY_URL,
    })
  })

  it('treats an unknown flag as the relay', () => {
    expect(resolveCarrier({ carrier: 'stockholm' }).name).toBe('relay')
  })
})
