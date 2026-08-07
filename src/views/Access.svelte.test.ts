/* Who can see this home — and what a viewer is shown instead.
 *
 * The rule under test is the one that is easiest to get subtly wrong: a
 * viewer's app must be honest about what it cannot do. Hiding a control is
 * fine; drawing one that the box will refuse is not, because the person taps
 * it, watches it fail, and learns that the app lies.
 *
 * Real Session, real SimBox, real loopback carrier. The passkey ceremony is
 * the one thing stubbed — there is no authenticator in jsdom — and it is
 * stubbed at the module the app would call, so the round trip that discovers
 * the step-up is needed still really happens over the wire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Access from './Access.svelte'
import { SiteStore } from '$lib/state/site.svelte'
import { AccessStore } from '$lib/state/access.svelte'
import { LoopbackCarrier } from '$lib/carrier/loopback'
import { SimBox } from '$lib/sim/box'
import { ROLE_OWNER, ROLE_VIEWER } from '$lib/protocol/messages'
import { parseEnrollmentUrl } from '$lib/identity/enrollment'
import { decodeDrawnQr } from '../../tests/support/qr'

vi.mock('$lib/identity/stepup', () => ({
  stepUp: vi.fn(async () => 'done'),
  stepUpHelp: () => 'needs a ceremony',
}))

// The roster marks this phone's own row, which means reading the vault. jsdom
// has no IndexedDB, and which row is this one is not what is under test.
vi.mock('$lib/identity/vault', () => ({
  openVaultStore: () => ({}),
  deviceIdOnBox: async () => null,
}))

const NOON = new Date(2026, 6, 15, 12, 0, 0).getTime()

function open(role?: string) {
  const box = new SimBox({ now: () => Date.now(), ...(role ? { role } : {}) })
  const site = new SiteStore('test')
  site.connect(new LoopbackCarrier(box, { latencyMs: 0 }))
  return { box, site }
}

function text(): string {
  return document.body.textContent ?? ''
}

function buttonSaying(pattern: RegExp): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) =>
    pattern.test(b.textContent ?? '')
  ) as HTMLButtonElement | undefined
}

describe('the sharing surface', () => {
  beforeEach(async () => {
    // restoreAllMocks below strips the factory's implementation, so the
    // ceremony is put back for every test rather than only the first. Without
    // this the fifth test's failure silently became the sixth test's.
    const { stepUp } = await import('$lib/identity/stepup')
    vi.mocked(stepUp).mockResolvedValue('done')
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('lists the phones an owner has admitted, with what each one is', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { site } = open()

    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    expect(text()).toContain('Owner')
    expect(text()).toContain('Viewer')
    expect(buttonSaying(/Invite someone to view/)).toBeDefined()
    // The box's field names, read as the box writes them. "not seen yet" on
    // every row is what a camelCase misreading looks like, and it renders
    // perfectly.
    expect(text()).toMatch(/here now|min ago|h ago/)
  })

  it('claims nothing about the box until the box has said something', async () => {
    // A cold start: the app paints before the handshake answers, which is the
    // whole product principle. What it must not do in that frame is state a
    // fact about the box.
    //
    // It stated two. `caps` starts empty, so the screen said this box's
    // software was too old for sharing — a fault nobody had confirmed, about a
    // box that had not spoken. And `role` starts owner, so a viewer's phone
    // spent the same frame believing it owned the house. Both are the same
    // error as a stale reading styled as current.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    // No carrier at all, which is exactly the state a phone launching from
    // cache is in until hello_ok lands.
    const site = new SiteStore('test')

    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(200)

    expect(text(), 'invented a fault in the box').not.toMatch(/newer software/i)
    expect(text(), 'told this phone what it is before the box did').not.toMatch(/view-only/i)
    expect(document.querySelectorAll('button'), 'drew a control on a guess').toHaveLength(0)
    expect(text()).toMatch(/reaching your box/i)
  })

  it('shows a viewer no roster and no buttons, and says why', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { site } = open(ROLE_VIEWER)

    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    expect(site.role).toBe(ROLE_VIEWER)
    expect(text()).toMatch(/view-only access/i)
    // Not one control, not even a disabled one. A disabled Remove tells a
    // guest exactly as little and looks like something broken.
    expect(document.querySelectorAll('button')).toHaveLength(0)
  })

  it('mints an invitation, and hands it over as a square rather than text', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { site } = open()

    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    buttonSaying(/Invite someone to view/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    // The payload, in the household's hands. It carries no role — the box
    // remembers which one it minted the code for, so nobody can edit theirs.
    expect(text().replace(/\s+/g, ' ')).toMatch(
      /It lets them see this home and nothing else, and it works once/
    )

    // What the screen must NOT contain. The payload is the box's static key,
    // a live pairing code and the rendezvous secret; printed as characters it
    // can be read over a shoulder, copied into a message or left in a
    // screenshot. The box's own page states the rule beside its own drawing:
    // the only path a payload may take is a camera.
    expect(text(), 'the payload was printed as text').not.toContain('#v2.')

    // And what a camera pointed at this screen would get instead. Decoded
    // rather than merely present — an SVG that is there and unreadable is the
    // failure this whole component exists to make impossible.
    // Awaited rather than read straight away: the encoder is fetched when
    // there is something to draw, and that module load is the one thing on
    // this screen that is not instant.
    const svg = await vi.waitFor(() => {
      const el = document.querySelector('svg[role="img"]')
      expect(el, 'nothing was drawn for the person joining').toBeTruthy()
      return el as SVGSVGElement
    })

    const scanned = decodeDrawnQr(svg)
    expect(scanned, 'the square on screen decodes to nothing').toBeTruthy()
    // A payload this app's own parser accepts, from its own encoder — which
    // is what makes the square worth pointing a camera at.
    expect(() => parseEnrollmentUrl(scanned!)).not.toThrow()
  })

  it('removes a phone only after it is confirmed, and the box loses the row', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { box, site } = open()

    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    const before = box.api.devices.length
    expect(before).toBe(2)

    buttonSaying(/^\s*Remove\s*$/)!.click()
    await vi.advanceTimersByTimeAsync(10)
    // Still there: the first tap only asks.
    expect(box.api.devices).toHaveLength(before)

    buttonSaying(/^\s*Remove\s*$/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    expect(box.api.devices, 'the box still trusts a phone the owner removed').toHaveLength(
      before - 1
    )
  })

  it('says what happened when a write is refused, and leaves nothing hanging', async () => {
    // Found in a browser rather than here: the step-up returns "no passkey on
    // this phone", the store recorded the sentence and rethrew, and nothing
    // was awaiting it. The screen looked right and the page carried an
    // unhandled rejection — which is also how a suite prints "all passed" and
    // still exits non-zero.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const stepup = await import('$lib/identity/stepup')
    vi.mocked(stepup.stepUp).mockResolvedValueOnce('unavailable')

    const { box, site } = open()
    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    buttonSaying(/Invite someone to view/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    expect(text()).toContain('needs a ceremony')
    // And the box minted nothing, because no handler ever ran.
    expect(box.api.devices).toHaveLength(2)

    // The rule itself, asserted where it can be seen. Watching for an
    // 'unhandledrejection' event instead passed just as happily against a
    // store that rethrows — jsdom raises none — which is the shape of test
    // this project has already lost rounds to.
    vi.mocked(stepup.stepUp).mockResolvedValueOnce('unavailable')
    const store = new AccessStore(site)
    const settled = store.inviteViewer()
    await vi.advanceTimersByTimeAsync(500)

    await expect(
      settled,
      'a write that fails must settle, not reject: the button that started it does not await'
    ).resolves.toBe(false)
    expect(store.error).toContain('needs a ceremony')
  })

  it('asks the box for a viewer in the field the box reads', async () => {
    // The wire shape, asserted on the wire. It was a query parameter for a
    // release: the box reads the role from a JSON body, so the field arrived
    // as absent, and absent meant owner. Every "invite someone to view" was a
    // house handed over — and this suite stayed green throughout, because the
    // simulator read the query string too.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { site } = open()
    const asked = vi.spyOn(site, 'api')

    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    buttonSaying(/Invite someone to view/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    const mint = asked.mock.calls
      .map(([req]) => req)
      .find((req) => req.path === '/api/app-link/pairing')
    expect(mint, 'the invite button asked the box for nothing').toBeDefined()

    expect(
      mint!.query,
      'the role went in the query string, where the box does not look'
    ).toBeUndefined()
    const body = JSON.parse(new TextDecoder().decode(mint!.body!)) as { role?: string }
    expect(body.role).toBe(ROLE_VIEWER)
  })

  it('draws no square when the box did not make the invitation view-only', async () => {
    // The other half of the same rule. Asking correctly is not enough: the
    // sentence beside this square promises the person joining can change
    // nothing, and that promise is the box's to keep. An answer naming
    // anything else is a failure here, not a square under the wrong sentence.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { site } = open()

    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    const real = site.api.bind(site)
    vi.spyOn(site, 'api').mockImplementation(async (req) => {
      if (req.path !== '/api/app-link/pairing') return real(req)
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: new TextEncoder().encode(
          JSON.stringify({
            url: 'https://app.ftw.energy/p#v2.a.b.c.d',
            role: ROLE_OWNER,
            expires_at_ms: NOON + 600_000,
          })
        ),
      }
    })

    buttonSaying(/Invite someone to view/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    expect(document.querySelector('svg[role="img"]'), 'an owner\'s code was drawn').toBeNull()
    expect(text()).toMatch(/nothing has been shared/i)
    expect(text().replace(/\s+/g, ' ')).not.toMatch(/It lets them see this home and nothing else/)
  })

  it('never says nobody is paired when the list simply did not arrive', async () => {
    // An owner whose phone is demonstrably on the box's list was told the box
    // had no phones at all, for any dropped connection during the first read.
    // A roster the app has not got is not an empty roster — the same rule as
    // never drawing a reading it does not have.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)

    const box = new SimBox({ now: () => Date.now() })
    const carrier = new LoopbackCarrier(box, { latencyMs: 20 })
    const site = new SiteStore('test')
    const asked = vi.spyOn(site, 'api')
    site.connect(carrier)

    render(Access, { props: { site } })

    for (let i = 0; i < 50 && asked.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(5)
    }
    expect(asked.mock.calls.length).toBe(1)

    // The read is already on the wire; what goes missing is the answer. The
    // wire stays up, so the session never moves phase and no reconnect is
    // coming to rescue the screen — which is the quiet half of this failure
    // and the half a person actually meets.
    box.faults = { ...box.faults, frameLossRate: 1 }
    await vi.advanceTimersByTimeAsync(21_000)

    expect(site.session.phase).toBe('streaming')
    expect(text(), 'a failed read was rendered as a fact about the house').not.toMatch(
      /No phones are paired/i
    )
    expect(text()).toMatch(/has not come through yet/i)

    // And it heals, with nothing to press. There is no reconnect button in
    // this app and reloading is never the fix, so the list has to arrive on
    // its own once the box is answering again.
    box.faults = { ...box.faults, frameLossRate: 0 }
    await vi.advanceTimersByTimeAsync(31_000)

    expect(asked.mock.calls.length, 'the roster was never asked for again').toBeGreaterThan(1)
    expect(text(), 'the roster stayed empty against a box that was answering').toContain('Owner')
    expect(text()).not.toMatch(/has not come through yet/i)
  })

  it('takes a phone off the list when the box says it was already gone', async () => {
    // Two owners, one roster a few seconds old, and the other owner removes
    // the same phone first. The box answers 404 — that phone is no longer
    // paired — which is the outcome asked for, not a failure. Showing red
    // text and leaving the row there tells the household the opposite of what
    // their box just said.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { box, site } = open()

    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    const store = new AccessStore(site)
    const listed = store.load()
    await vi.advanceTimersByTimeAsync(500)
    await listed
    const before = store.members.length
    expect(before).toBe(2)

    const viewer = box.api.devices.find((d) => d.role !== ROLE_OWNER)!
    // Removed at the box, behind this screen's back.
    const elsewhere = new AccessStore(site).revoke(viewer.id)
    await vi.advanceTimersByTimeAsync(500)
    await elsewhere

    const gone = store.revoke(viewer.id)
    await vi.advanceTimersByTimeAsync(500)

    await expect(gone, 'a phone that is already gone counts as removed').resolves.toBe(true)
    expect(store.members).toHaveLength(before - 1)
    expect(store.error, 'a done thing was reported as a problem').toBeNull()
  })

  it('says why when the box refuses to lose its last owner', async () => {
    // The screen hides that Remove, so this asks the store directly — the way
    // a phone whose roster is a few seconds stale would arrive at it.
    //
    // What is under test is the seam, not the sentence. The box answers 409
    // with a sentence for its own page AND a code for this app, and the app
    // reads only the code: a 409 alone is a conflict and nothing more
    // specific, so reading it as the last-owner rule would put this sentence
    // under every other conflict the box will ever have. The app branched on
    // a "code" key the box did not send for a release, which made this the
    // one refusal a household could meet and never understand.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { box, site } = open()

    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    const owner = box.api.devices.find((d) => d.role === ROLE_OWNER)!
    const store = new AccessStore(site)
    const gone = store.revoke(owner.id)
    await vi.advanceTimersByTimeAsync(500)

    await expect(gone).resolves.toBe(false)
    expect(store.error).toMatch(/last owner cannot be removed/i)
    expect(store.error, 'the box’s own wording reached the screen').not.toMatch(
      /Pair another owner first/
    )
    expect(box.api.devices, 'the box lost its last owner').toHaveLength(2)
  })

  it('never offers to remove the last owner', async () => {
    // Refused at the box as well. This is the app agreeing with the rule
    // rather than the app being the rule.
    vi.useFakeTimers()
    vi.setSystemTime(NOON)
    const { box, site } = open()

    render(Access, { props: { site } })
    await vi.advanceTimersByTimeAsync(500)

    // Remove the viewer, leaving one owner and nothing else.
    buttonSaying(/^\s*Remove\s*$/)!.click()
    await vi.advanceTimersByTimeAsync(10)
    buttonSaying(/^\s*Remove\s*$/)!.click()
    await vi.advanceTimersByTimeAsync(500)

    expect(box.api.devices).toHaveLength(1)
    expect(text()).toContain('last owner')
  })
})
