import { describe, expect, it, afterEach, vi } from 'vitest'
import { canScan, scanForEnrollment } from './scan'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fakeStream() {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  return { stream, stop }
}

function readyVideo(): HTMLVideoElement {
  const video = document.createElement('video')
  Object.defineProperties(video, {
    srcObject: { value: null, writable: true, configurable: true },
    readyState: { value: 2, configurable: true },
    play: { value: vi.fn().mockResolvedValue(undefined), configurable: true },
  })
  return video
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  withCamera(false)
  withBarcodeDetector(false)
  document.body.replaceChildren()
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

describe('scanner lifetime', () => {
  it('stops a camera stream that arrives after startup was cancelled', async () => {
    const camera = deferred<MediaStream>()
    const { stream, stop } = fakeStream()
    const onCode = vi.fn()
    const controller = new AbortController()
    const video = readyVideo()

    Object.defineProperty(nav(), 'mediaDevices', {
      value: { getUserMedia: vi.fn(() => camera.promise) },
      configurable: true,
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const starting = scanForEnrollment(video, onCode, controller.signal)
    controller.abort()
    camera.resolve(stream)
    const handle = await starting

    expect(stop, 'the late camera stayed open').toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
    expect(onCode).not.toHaveBeenCalled()

    // The handle still resolves so cancellation cannot repaint the pairing
    // screen as a camera error when the permission sheet finally closes.
    expect(() => handle.stop()).not.toThrow()
  })

  it('drops a code decoded after stop', async () => {
    const found = deferred<{ rawValue: string }[]>()
    const detect = vi.fn((_source: CanvasImageSource) => found.promise)
    const { stream, stop } = fakeStream()
    const onCode = vi.fn()
    const video = readyVideo()
    const frames: FrameRequestCallback[] = []
    let nextFrame = 0

    Object.defineProperty(nav(), 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => stream) },
      configurable: true,
    })
    ;(globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = class {
      detect(source: CanvasImageSource) {
        return detect(source)
      }
    }
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback)
        return ++nextFrame
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const handle = await scanForEnrollment(video, onCode)
    frames.shift()!(0) // skipped frame
    frames.shift()!(1) // detect starts and waits
    expect(detect).toHaveBeenCalledOnce()

    handle.stop()
    found.resolve([{ rawValue: 'https://app.ftw.energy/p#v2.example' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(stop).toHaveBeenCalledOnce()
    expect(onCode, 'a stopped scan accepted a late decode').not.toHaveBeenCalled()
    expect(frames, 'a stopped scan scheduled another frame').toHaveLength(0)
  })
})
