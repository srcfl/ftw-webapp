import { describe, expect, it, afterEach } from 'vitest'
import { canScan } from './scan'

/**
 * The button must not depend on BarcodeDetector.
 *
 * It did, and Safari has never shipped that API, so every iPhone reached the
 * pairing screen with no way to scan — on the one platform this app exists to
 * replace an app on. The decoder is fetched on demand now, so a camera is the
 * only thing worth asking about.
 */

type Nav = { mediaDevices?: { getUserMedia?: unknown } }

const nav = () => globalThis.navigator as unknown as Nav

function withCamera(present: boolean) {
  const n = nav()
  if (present) {
    Object.defineProperty(n, 'mediaDevices', {
      value: { getUserMedia: () => Promise.resolve({}) },
      configurable: true,
    })
  } else {
    Object.defineProperty(n, 'mediaDevices', { value: undefined, configurable: true })
  }
}

function withBarcodeDetector(present: boolean) {
  const g = globalThis as { BarcodeDetector?: unknown }
  if (present) g.BarcodeDetector = class {}
  else delete g.BarcodeDetector
}

afterEach(() => {
  withBarcodeDetector(false)
})

describe('canScan', () => {
  it('is true on a browser with a camera and no BarcodeDetector', () => {
    // Safari, every version. The regression this file exists for.
    withCamera(true)
    withBarcodeDetector(false)
    expect(canScan()).toBe(true)
  })

  it('is true where BarcodeDetector exists', () => {
    withCamera(true)
    withBarcodeDetector(true)
    expect(canScan()).toBe(true)
  })

  it('is false without a camera', () => {
    // A desktop with no webcam gets the link instead, not a button that
    // opens a permission sheet for a device that is not there.
    withCamera(false)
    withBarcodeDetector(true)
    expect(canScan()).toBe(false)
  })
})
