/* Reading the code off the box.
 *
 * BarcodeDetector where it exists — Chrome and Edge — because it costs nothing
 * and decodes off the main thread. Safari does not have it, on any version,
 * and iPhone is the phone this app is for. So there is a decoder behind a
 * dynamic import: it never enters the launch bundle, and it is fetched once,
 * at the moment someone taps Scan on a browser that needs it.
 *
 * Pointing the phone's own camera at the code still works and opens the same
 * link. That is a fine second path, but it cannot be the only one — a person
 * who has just installed an app expects to scan from inside it.
 */

export interface ScanHandle {
  stop: () => void
}

export type ScanErrorCode = 'unsupported' | 'denied' | 'no-camera' | 'failed'

export class ScanError extends Error {
  constructor(
    readonly code: ScanErrorCode,
    /** A sentence for the user: what to do now, not what broke. */
    readonly userMessage: string
  ) {
    super(code)
    this.name = 'ScanError'
  }
}

interface DetectedBarcode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike

function detectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  return ctor ?? null
}

/**
 * A camera is the whole requirement.
 *
 * Decoding is no longer a reason to hide the button: where BarcodeDetector is
 * missing the fallback is fetched on demand. This must stay a camera check
 * only — gating it on the detector is what left iPhone with no button at all.
 */
export function canScan(): boolean {
  return typeof navigator?.mediaDevices?.getUserMedia === 'function'
}

/**
 * The decoder, whichever this browser can use.
 *
 * Both shapes are reduced to one call: give it a video frame, get back the
 * strings found in it. The import is inside the fallback branch so a browser
 * with BarcodeDetector never fetches the chunk.
 */
type Decode = (video: HTMLVideoElement) => Promise<string[]>

async function decoder(): Promise<Decode> {
  const Ctor = detectorCtor()
  if (Ctor) {
    const detector = new Ctor({ formats: ['qr_code'] })
    return async (video) => (await detector.detect(video)).map((c) => c.rawValue)
  }

  const { default: jsQR } = await import('jsqr')

  // One canvas for the whole scan, sized to the frame on first use. Allocating
  // per frame is what makes a software decoder feel slow on a phone.
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new ScanError('failed', "The camera didn't start. Try again.")

  return async (video) => {
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return []
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.drawImage(video, 0, 0, w, h)
    const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
      inversionAttempts: 'dontInvert',
    })
    return found ? [found.data] : []
  }
}

/**
 * Start the camera and call `onCode` with the first code that looks like ours.
 *
 * Codes that are not FTW links are ignored rather than reported: a camera
 * pointed at a room will find wifi codes and product barcodes, and stopping
 * to explain each one would make the scanner feel broken.
 */
export async function scanForEnrollment(
  video: HTMLVideoElement,
  onCode: (raw: string) => void
): Promise<ScanHandle> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // The back camera is the one pointing at the box.
      video: { facingMode: 'environment' },
      audio: false,
    })
  } catch (err) {
    const name = (err as { name?: string }).name
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new ScanError(
        'denied',
        'Camera access is off for this app. Turn it on in your browser settings, or point your phone camera at the code instead.'
      )
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new ScanError(
        'no-camera',
        "No camera here. Point your phone's camera at the code instead — it opens the same link."
      )
    }
    throw new ScanError('failed', "The camera didn't start. Try again.")
  }

  video.srcObject = stream
  video.setAttribute('playsinline', '') // iOS goes fullscreen without it
  await video.play().catch(() => {})

  let running = true
  let frame = 0

  const stop = () => {
    running = false
    cancelAnimationFrame(frame)
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
  }

  // After the camera, so the permission sheet is the first thing that happens
  // and the fetch overlaps with the person aiming at the box. If it fails the
  // camera is already open and must be released.
  let detect: Decode
  try {
    detect = await decoder()
  } catch (err) {
    stop()
    if (err instanceof ScanError) throw err
    throw new ScanError(
      'unsupported',
      "The scanner didn't load. Point your phone's camera at the code instead — it opens the same link."
    )
  }

  // Every other frame. Detection at 60 Hz burns battery for no gain — a code
  // held in front of a camera is there for a second at least.
  let skip = false
  const tick = async () => {
    if (!running) return

    skip = !skip
    if (!skip && video.readyState >= 2) {
      try {
        for (const raw of await detect(video)) {
          if (looksLikeEnrollment(raw)) {
            stop()
            onCode(raw)
            return
          }
        }
      } catch {
        // A dropped frame is not worth reporting; the next one usually works.
      }
    }

    frame = requestAnimationFrame(() => void tick())
  }

  frame = requestAnimationFrame(() => void tick())
  return { stop }
}

/**
 * Cheap shape check, so unrelated codes in view are ignored silently.
 *
 * Any version, not just ours: a payload from a box we are too old for must
 * reach the parser, which is the only thing that can say "update the app".
 * Matching our version alone would leave the camera looking past it forever.
 */
function looksLikeEnrollment(raw: string): boolean {
  return /\/p#v\d+\./.test(raw)
}
