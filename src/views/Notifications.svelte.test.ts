/* Notifications, from the tap to the box's own record.
 *
 * Real Session, real SimBox, real loopback carrier — the same arrangement as
 * the sharing tests, and for the same reason: a subscription that only ever
 * reached a stub proves the app agreed with itself. Two things have no jsdom
 * implementation and are faked at the platform seam instead: the permission
 * prompt and the push registration, because there is no push service in a
 * test runner. The passkey ceremony is stubbed at the module the app calls,
 * so the round trip that discovers the step-up still happens over the wire.
 *
 * The rules the section must keep are this app's usual ones, applied to
 * push: no button a viewer's box would refuse, no claim about a box that has
 * not spoken, honest sentences for a phone that cannot do push and a box
 * that does not know how — and nothing sent anywhere until someone taps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Notifications from './Notifications.svelte'
import { NotifyStore } from '$lib/state/notify.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { ApiError } from '$lib/protocol/session'
import { ROLE_VIEWER } from '$lib/protocol/messages'

vi.mock('$lib/identity/stepup', () => ({
  stepUp: vi.fn(async () => 'done'),
  stepUpHelp: () => 'needs a ceremony',
}))

const NOON = new Date(2026, 6, 15, 12, 0, 0).getTime()

function open(role?: string) {
  const box = new SimBox({ now: () => Date.now(), ...(role ? { role } : {}) })
  const site = new SiteStore('test')
  site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
  return { box, site }
}

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

function buttonSaying(pattern: RegExp): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) =>
    pattern.test(b.textContent ?? '')
  ) as HTMLButtonElement | undefined
}

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

/**
 * The platform half of push, at the seam the app calls: the permission
 * prompt, and a push manager whose one subscription behaves like the real
 * one — created by subscribe, readable back, gone after unsubscribe.
 */
function installPush(opts: { answer?: NotificationPermission; subscribed?: boolean } = {}) {
  let subscription: {
    toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } }
    unsubscribe: () => Promise<boolean>
  } | null = null

  const makeSubscription = () => ({
    toJSON: () => ({
      endpoint: 'https://push.example/p/one',
      keys: { p256dh: 'BPdh-key', auth: 'auth-key' },
    }),
    unsubscribe: vi.fn(async () => {
      subscription = null
      return true
    }),
  })
  if (opts.subscribed) subscription = makeSubscription()

  const pushManager = {
    getSubscription: vi.fn(async () => subscription),
    subscribe: vi.fn(async (_asked: unknown) => {
      subscription = makeSubscription()
      return subscription
    }),
  }
  const requestPermission = vi.fn(async () => opts.answer ?? ('granted' as NotificationPermission))

  vi.stubGlobal('Notification', { permission: 'default', requestPermission })
  vi.stubGlobal('PushManager', class {})
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager }) },
  })

  return { pushManager, requestPermission, subscribed: () => subscription !== null }
}

describe('the notifications section', () => {
  beforeEach(async () => {
    // restoreAllMocks strips the factory's implementation, so the ceremony is
    // put back for every test rather than only the first.
    const { stepUp } = await import('$lib/identity/stepup')
    vi.mocked(stepUp).mockResolvedValue('done')
    vi.stubGlobal('localStorage', stubStorage())
  })

  afterEach(() => {
    document.body.replaceChildren()
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('turns on with one tap, and the box ends up holding this phone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const push = installPush()
    const { box, site } = open()

    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    expect(box.api.pushSubscriptions, 'the screen subscribed before anyone asked').toEqual([])
    buttonSaying(/Turn on notifications/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    // The prompt ran, the subscription was made with the box's own key and
    // the always-visible promise Safari holds workers to, and the box now
    // knows where to send.
    expect(push.requestPermission).toHaveBeenCalledOnce()
    const asked = push.pushManager.subscribe.mock.calls[0]![0] as {
      userVisibleOnly?: boolean
      applicationServerKey?: Uint8Array
    }
    expect(asked.userVisibleOnly).toBe(true)
    expect(asked.applicationServerKey).toBeInstanceOf(Uint8Array)
    expect(asked.applicationServerKey!.length, 'not an uncompressed P-256 point').toBe(65)
    expect(asked.applicationServerKey![0]).toBe(4)
    expect(box.api.pushSubscriptions).toEqual(['https://push.example/p/one'])

    // And the section now offers what an enabled phone can do.
    expect(buttonSaying(/Send a test/)).toBeDefined()
    expect(buttonSaying(/Turn off notifications/)).toBeDefined()
    expect(text()).toContain('When the car finishes charging')
  })

  it('shows the box’s own record of what it has sent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    installPush({ subscribed: true })
    const { site } = open()

    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    // The sim's history rows, rendered as the box worded them at send time.
    expect(text()).toContain('Car charged')
    expect(text()).toContain('Your box updated itself')
  })

  it('saves the toggles as one write, one ceremony', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    installPush({ subscribed: true })
    const { box, site } = open()
    const stepup = await import('$lib/identity/stepup')

    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    // Three switches: box.unreachable has none — the box cannot gate a
    // message about its own absence, so it follows the subscription itself.
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(boxes.length).toBe(3)

    // Everything starts off, because the box seeds every rule disabled —
    // sparse by design. Two edits, and no save yet: a toggle is an edit,
    // not a request.
    expect(boxes.every((b) => !b.checked)).toBe(true)
    boxes[0]!.click()
    await vi.advanceTimersByTimeAsync(10)
    boxes[1]!.click()
    await vi.advanceTimersByTimeAsync(10)
    expect(box.api.pushRules['charging.session_complete'], 'a toggle wrote on its own').toBe(false)

    // Counted from here: the module mock's history survives other tests.
    vi.mocked(stepup.stepUp).mockClear()
    buttonSaying(/^\s*Save\s*$/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    expect(box.api.pushRules['charging.session_complete']).toBe(true)
    expect(box.api.pushRules['charging.interrupted']).toBe(true)
    expect(box.api.pushRules['update.installed']).toBe(false)
    expect(vi.mocked(stepup.stepUp), 'the batch cost more than one ceremony').toHaveBeenCalledOnce()
  })

  it('asks the box to send a test through the whole pipe', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    installPush({ subscribed: true })
    const { box, site } = open()

    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    buttonSaying(/Send a test/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    expect(box.api.testPushes).toBe(1)
    expect(text()).toMatch(/Sent — it shows up on this phone in a moment/)
  })

  it('turns off at the box first, then on this phone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const push = installPush()
    const { box, site } = open()

    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)
    buttonSaying(/Turn on notifications/)!.click()
    await vi.advanceTimersByTimeAsync(500)
    expect(box.api.pushSubscriptions).toHaveLength(1)

    buttonSaying(/Turn off notifications/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    expect(box.api.pushSubscriptions, 'the box kept sending to a phone that left').toEqual([])
    expect(push.subscribed(), 'the browser kept a subscription nothing feeds').toBe(false)
    expect(buttonSaying(/Turn on notifications/)).toBeDefined()
  })

  it('tells a phone that cannot do push what to do, and draws nothing else', async () => {
    // No Notification, no PushManager: iOS in a browser tab, where the push
    // machinery only exists once the app is installed. The sentence is the
    // instruction; a disabled button would be a lie about whose move it is.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { site } = open()

    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    expect(text()).toContain('Add this app to your home screen first')
    expect(document.querySelectorAll('button'), 'drew a control push cannot honour').toHaveLength(0)
  })

  it('shows a viewer a sentence, not a button their box would refuse', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    installPush()
    const { site } = open(ROLE_VIEWER)

    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    expect(text()).toMatch(/turned on by this home's owner/i)
    expect(document.querySelectorAll('button')).toHaveLength(0)
  })

  it('says whose the refusal is when a viewer’s store asks anyway', async () => {
    // The screen hides the button, so this asks the store directly — the way
    // a phone whose role changed under it would arrive at the same request.
    // The box refuses before any ceremony, the sentence is the app's scope
    // prose, and the local subscription is taken back down: a switch showing
    // on for pushes the box will never send is the lie this section must not
    // tell.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const push = installPush()
    const { box, site } = open(ROLE_VIEWER)
    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    const store = new NotifyStore(site)
    const settled = store.enable()
    await vi.advanceTimersByTimeAsync(500)
    await settled

    expect(store.error).toMatch(/Only the owner of this home can change that/)
    expect(store.enabled).toBe(false)
    expect(box.api.pushSubscriptions).toEqual([])
    expect(push.subscribed(), 'kept a subscription the box refused to feed').toBe(false)
  })

  it('meets an old box with the existing sentence, before any button is drawn', async () => {
    // The history read doubles as the probe: a box without these routes
    // answers E_UNKNOWN_OP to it, which is how the enable button never
    // appears on a box that would refuse the whole flow — after the person
    // had already granted permission.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    installPush()
    const { site } = open()
    const real = site.api.bind(site)
    vi.spyOn(site, 'api').mockImplementation(async (req) => {
      if (req.path.startsWith('/api/notifications/')) {
        throw new ApiError({ code: 'E_UNKNOWN_OP', retryable: false, args: { t: 'api.req' } })
      }
      return real(req)
    })

    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    expect(text()).toContain("Your box doesn't have that yet")
    expect(buttonSaying(/Turn on notifications/), 'offered a flow the box will refuse').toBeUndefined()
  })

  it('says how to undo a denial, in the app’s voice', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const push = installPush({ answer: 'denied' })
    const { box, site } = open()

    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)
    buttonSaying(/Turn on notifications/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    expect(text()).toMatch(/browser's settings/i)
    expect(push.pushManager.subscribe, 'subscribed a phone that said no').not.toHaveBeenCalled()
    expect(box.api.pushSubscriptions).toEqual([])
  })

  it('claims nothing about the box until the box has said something', async () => {
    // A cold start paints before the handshake answers. What it must not do
    // in that frame is state a fact about the box — the capability, the
    // role — so the section says only that it is reaching for one.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    installPush()
    const site = new SiteStore('test')

    render(Notifications, { props: { site } })
    await vi.advanceTimersByTimeAsync(200)

    expect(text(), 'invented a fault in the box').not.toMatch(/newer software/i)
    expect(text(), 'guessed at this phone’s role').not.toMatch(/home's owner/i)
    expect(document.querySelectorAll('button'), 'drew a control on a guess').toHaveLength(0)
    expect(text()).toMatch(/reaching your box/i)
  })
})
