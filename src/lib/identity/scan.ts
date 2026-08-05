/* Reading the code off the box.
 *
 * BarcodeDetector where it exists, which is Chrome, Edge and — since 17 —
 * Safari. It is the only option that costs nothing: no decoder in the bundle,
 * and detection happens off the main thread.
 *
 * Where it does not exist there is deliberately no fallback decoder. Shipping
 * one would add tens of kilobytes to every launch to serve a shrinking
 * minority, and there is already a path that always works: open the QR's link
 * directly. A phone that cannot scan in-app can still point its own camera at
 * the box, and the operating system opens the same URL.
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

export function canScan(): boolean {
  return detectorCtor() !== null && typeof navigator?.mediaDevices?.getUserMedia === 'function'
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
  const Ctor = detectorCtor()
  if (!Ctor) {
    throw new ScanError(
      'unsupported',
      "This browser can't scan in-app. Point your phone's camera at the code instead — it opens the same link."
    )
  }

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

  const detector = new Ctor({ formats: ['qr_code'] })
  let running = true
  let frame = 0

  const stop = () => {
    running = false
    cancelAnimationFrame(frame)
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
  }

  // Every other frame. Detection at 60 Hz burns battery for no gain — a code
  // held in front of a camera is there for a second at least.
  let skip = false
  const tick = async () => {
    if (!running) return

    skip = !skip
    if (!skip && video.readyState >= 2) {
      try {
        for (const code of await detector.detect(video)) {
          if (looksLikeEnrollment(code.rawValue)) {
            stop()
            onCode(code.rawValue)
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
