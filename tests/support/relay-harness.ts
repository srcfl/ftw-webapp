/* Test rig for the relay: a raw peer, a sealed carrier, and the pairing of
 * the two into a real session over a real socket.
 *
 * The sealing carrier here is a stand-in. The real one belongs to the crypto
 * layer, and the relay's blindness does not depend on which of them wraps the
 * frames — only on there being a seal at all. Building the proof against a
 * local one keeps it from waiting on another layer to land.
 */

import { CarrierBase, type Carrier, type CarrierStatus } from '$lib/carrier/carrier'
import { RelayCarrier } from '$lib/carrier/relay'
import { rendezvousHandle, currentEpoch } from '$lib/carrier/rendezvous'
import { HandshakeState, generateKeyPair, type KeyPair } from '$lib/crypto/noise'
import { NoiseTransport } from '$lib/crypto/transport'
import { Session } from '$lib/protocol/session'
import { SimBox, type SimBoxOptions } from '$lib/sim/box'
import type { CarrierState } from '$lib/protocol/types'

export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 4000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** A socket that speaks the relay's join path and records everything. */
export class TestPeer {
  readonly sent: Uint8Array[] = []
  readonly received: Uint8Array[] = []
  readonly control: string[] = []
  readonly closes: { code: number; reason: string }[] = []

  #ws: WebSocket
  #binary: ((bytes: Uint8Array) => void) | null = null

  constructor(url: string, epoch: number, handle: string, role: 'box' | 'app') {
    this.#ws = new WebSocket(`${url}/r/${epoch}/${handle}/${role}`)
    this.#ws.binaryType = 'arraybuffer'
    this.#ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.control.push(ev.data)
        return
      }
      const bytes = new Uint8Array(ev.data as ArrayBuffer)
      this.received.push(bytes)
      this.#binary?.(bytes)
    }
    this.#ws.onclose = (ev) => this.closes.push({ code: ev.code, reason: ev.reason })
    this.#ws.onerror = () => {}
  }

  get open(): boolean {
    return this.#ws.readyState === 1
  }

  get linked(): boolean {
    return this.control.at(-1) === 'ready'
  }

  onBinary(fn: (bytes: Uint8Array) => void): void {
    this.#binary = fn
  }

  send(bytes: Uint8Array): void {
    this.sent.push(bytes)
    this.#ws.send(bytes)
  }

  /** Bypasses the recorder, for tests that need to break the rules on purpose. */
  sendText(text: string): void {
    this.#ws.send(text)
  }

  close(): void {
    this.#ws.close()
  }
}

/**
 * Encrypts on the way out, decrypts on the way in, and is otherwise the
 * carrier it wraps. Frames that fail to authenticate are dropped: on a relay
 * that broadcasts an uplink to every stream in a room, most of them are simply
 * addressed to somebody else.
 */
export class SealingCarrier extends CarrierBase implements Carrier {
  readonly kind: CarrierState = 'relay'

  #inner: Carrier
  #transport: NoiseTransport
  #tap: ((sealed: Uint8Array) => void) | undefined

  constructor(inner: Carrier, transport: NoiseTransport, tap?: (sealed: Uint8Array) => void) {
    super()
    this.#inner = inner
    this.#transport = transport
    this.#tap = tap
    inner.onFrame((sealed) => {
      try {
        this.emitFrame(this.#transport.decrypt(sealed))
      } catch {
        /* not ours */
      }
    })
    inner.onStatus((status) => this.emitStatus(status))
  }

  get rttMs(): number | null {
    return this.#inner.rttMs
  }

  get status(): CarrierStatus {
    return this.#inner.status
  }

  send(frame: Uint8Array): void {
    const sealed = this.#transport.encrypt(frame)
    this.#tap?.(sealed)
    this.#inner.send(sealed)
  }

  close(reason?: string): void {
    this.#inner.close(reason)
  }
}

export interface SealedPair {
  session: Session
  box: SimBox
  boxPeer: TestPeer
  carrier: RelayCarrier
  /** Every byte that crossed the relay, in both directions. */
  wire: Uint8Array[]
  handle: string
  stop(): void
}

/**
 * A box and an app on either side of the relay, with a Noise session between
 * them and a subscription running.
 */
export async function sealedPair(
  relayUrl: string,
  secret: Uint8Array,
  boxOpts: SimBoxOptions = {}
): Promise<SealedPair> {
  const boxKeys: KeyPair = generateKeyPair()
  const appKeys: KeyPair = generateKeyPair()
  const wire: Uint8Array[] = []

  const epoch = currentEpoch()
  const handle = rendezvousHandle(secret, epoch)

  const boxPeer = new TestPeer(relayUrl, epoch, handle, 'box')
  const carrier = new RelayCarrier({ url: relayUrl, secret })

  await waitFor(() => carrier.status.phase === 'open' && boxPeer.linked, 'both peers in the room')

  // The handshake crosses the relay like everything else, so it lands in the
  // dump the blindness test inspects.
  const initiator = HandshakeState.initiator({ staticKey: appKeys, remoteStatic: boxKeys.publicKey })
  const responder = HandshakeState.responder({ staticKey: boxKeys })

  const handshake: Uint8Array[] = []
  const collect = carrier.onFrame((bytes) => handshake.push(bytes))

  const msg1 = initiator.writeMessage()
  wire.push(msg1)
  carrier.send(msg1)

  await waitFor(() => boxPeer.received.length > 0, 'handshake message 1 at the box')
  responder.readMessage(boxPeer.received[0]!)

  const msg2 = responder.writeMessage()
  wire.push(msg2)
  boxPeer.send(msg2)

  await waitFor(() => handshake.length > 0, 'handshake message 2 at the app')
  initiator.readMessage(handshake[0]!)
  collect()

  const boxTransport = new NoiseTransport(responder.split())
  const appTransport = new NoiseTransport(initiator.split())

  const box = new SimBox(boxOpts)
  box.onFrame((frame) => {
    const sealed = boxTransport.encrypt(frame)
    wire.push(sealed)
    boxPeer.send(sealed)
  })
  boxPeer.onBinary((sealed) => box.receive(boxTransport.decrypt(sealed)))

  // Tapped after the seal, which is what actually reaches the relay.
  const sealing = new SealingCarrier(carrier, appTransport, (sealed) => wire.push(sealed))

  const session = new Session({ build: 'test' })
  session.connect(sealing)

  await waitFor(() => session.state.phase === 'streaming', 'the snapshot')

  return {
    session,
    box,
    boxPeer,
    carrier,
    wire,
    handle,
    stop() {
      session.close()
      carrier.close()
      boxPeer.close()
    },
  }
}
