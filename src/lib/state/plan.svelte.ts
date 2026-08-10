/* The plan, and changing how the site is run.
 *
 * Kept apart from SiteStore because the plan is asked for rather than
 * streamed, and because a command in flight has a lifecycle the telemetry
 * path does not: sending, accepted, applied — or accepted and never
 * confirmed, which is its own answer and not a failure.
 */

import type { Plan, SiteMode, CmdResult, ModeInfo } from '$lib/protocol/messages'
import { OP_SET_MODE } from '$lib/protocol/messages'
import { CommandError } from '$lib/protocol/session'
import { commandHelp } from '$lib/format/command'
import { CAP_PLAN_DISPATCH, SCOPE_MODE_WRITE } from '$lib/protocol/contract'
import type { SiteStore } from './site.svelte'
import { FID } from '$lib/format/explanation'

/** What the user sees while an intent is in flight. */
export type CommandState =
  | { kind: 'idle' }
  | { kind: 'sending'; mode: SiteMode }
  | { kind: 'applied'; mode: SiteMode }
  | { kind: 'unconfirmed'; mode: SiteMode }
  | { kind: 'failed'; help: string }

/** How long a settled result stays on screen before the UI goes quiet again. */
const SETTLE_MS = 4_000

export class PlanStore {
  #site: SiteStore
  #timer: ReturnType<typeof setTimeout> | null = null

  /**
   * What the box intends to do, read where the session keeps it.
   *
   * The session holds the one copy, because a plan does not only arrive as an
   * answer: the box replans after a mode change made from any phone and
   * pushes the result unasked, with no request id. A copy held here caught
   * only the answers, so a long-lived connection drained to "no plan" while
   * the session's plan moved on without it.
   */
  get plan(): Plan | null {
    return this.#site.session.plan
  }

  /**
   * Bumped when something other than the session wants the plan again.
   *
   * Part of the name `askWhenLive` asks under, so a replan chased after a
   * mode change is the same rule as every other ask: one place decides when
   * to ask again, and one place heals an ask that failed.
   */
  want = $state(0)

  loading = $state(false)
  /** Set when the box could not answer. A sentence, never a code. */
  problem = $state<string | null>(null)
  command = $state<CommandState>({ kind: 'idle' })

  constructor(site: SiteStore) {
    this.#site = site
  }

  /**
   * Every mode this box accepts, as the box ordered them.
   *
   * The app renders what it is given rather than a list it was compiled with,
   * so a box running a newer FTW can offer a strategy this build has never
   * heard of. Hidden-tier modes are valid over the API but never buttons.
   */
  get modes(): ModeInfo[] {
    return this.#site.session.modes.filter((m) => m.tier !== 'hidden')
  }

  get primaryModes(): ModeInfo[] {
    return this.modes.filter((m) => m.tier === 'primary')
  }

  get advancedModes(): ModeInfo[] {
    return this.modes.filter((m) => m.tier === 'advanced')
  }

  /**
   * The mode the box reports, which is the only one that counts.
   *
   * Field 1 is an index into the catalogue the box sent at handshake, which
   * keeps lane 0 numeric and its frames a fixed size.
   *
   * While a change is in flight the UI shows the requested mode so the tap
   * feels immediate — but this getter never lies about what the box said, so
   * a rejected change snaps back rather than leaving a wrong state on screen.
   */
  get actualMode(): SiteMode | null {
    const index = this.#site.session.fields.get(FID.MODE)
    if (index === undefined) return null
    return this.#site.session.modes[index]?.key ?? null
  }

  /** What the toggle should show: the pending choice, else the real one. */
  get shownMode(): SiteMode | null {
    const c = this.command
    if (c.kind === 'sending' || c.kind === 'applied' || c.kind === 'unconfirmed') return c.mode
    return this.actualMode
  }

  /**
   * Whether to draw the mode buttons at all.
   *
   * Two questions, and both have to be yes. The box has to offer dispatch,
   * and this enrolment has to carry the scope the operation needs — the same
   * scope the box checks before the dispatcher ever sees the command. Drawing
   * a control a viewer will be refused is the one thing this app must not do:
   * they tap it, watch it fail, and learn that the app lies.
   *
   * Hiding is presentation. The refusal is still the box's, so an app that
   * gets this wrong is merely rude rather than unsafe.
   */
  get canControl(): boolean {
    return this.#site.session.caps.has(CAP_PLAN_DISPATCH) && this.#hasModeScope
  }

  /**
   * Why there are no buttons — because the two reasons are different
   * sentences, and "this box doesn't support it" is false for a guest in a
   * house whose box supports it perfectly.
   *
   * Null until the box has answered, and that is the third case rather than a
   * missing one. Before its hello, `caps` is empty because nobody asked and
   * `role` reads owner because that is what an old box means by silence —
   * rendered as an answer, the pair says "this box doesn't support changing
   * how it runs" on every cold start, about a box that has said nothing. The
   * sharing screen had the same bug and the same cause.
   */
  get whyNoControl(): 'box' | 'role' | null {
    if (!this.#site.session.heardFromBox) return null
    if (this.canControl) return null
    return this.#hasModeScope ? 'box' : 'role'
  }

  /**
   * The grant the box named, not this app's expansion of the role.
   *
   * `hello_ok` carries both, and the box sends both for exactly this: the
   * role is what the sentence beside the buttons names, and the scope list is
   * what a control is checked against. Expanding the role here instead put
   * this app's copy of the registry's table above the box's answer, so a box
   * whose table had moved on was overruled by an older one.
   */
  get #hasModeScope(): boolean {
    return this.#site.session.scopes.has(SCOPE_MODE_WRITE)
  }

  /**
   * Reload the plan until its revision moves past the one on screen.
   *
   * Every three seconds for at most thirty: the box acknowledges a mode
   * change before its optimizer has replanned, so the first fetch usually
   * returns the plan of the old mode with its old rev.
   */
  async #followPlan(): Promise<void> {
    const before = this.plan?.rev
    for (let attempt = 0; attempt < 10; attempt++) {
      // Asks by changing the question rather than fetching here. A fetch of
      // its own would be a second one outside `askWhenLive`, and when these
      // thirty seconds were up a failed one would leave the screen saying it
      // was still trying while nothing was.
      this.want += 1
      await new Promise((r) => setTimeout(r, 3_000))
      if (this.plan?.rev !== before) return
    }
  }

  /**
   * Ask for the plan, and say so when the box could not send one.
   *
   * The answer itself lands on session state, where `plan` reads it — this
   * only asks and owns the failure sentence. Rejects on failure as well as
   * saying it, because the caller that heals this — `askWhenLive` — has no
   * other way to tell an answer from a failure the store swallowed. The view
   * keeps whatever plan it had either way.
   */
  async load(): Promise<void> {
    this.loading = true
    this.problem = null
    try {
      await this.#site.plan()
    } catch (err) {
      // A plan the box could not send is not a broken app. What happens now
      // is that the app asks again on its own, so that is what it says — the
      // sentence is true because askWhenLive makes it true.
      this.problem = "Couldn't get the plan from your box. Still trying."
      throw err
    } finally {
      this.loading = false
    }
  }

  /**
   * Ask the box to run the site differently.
   *
   * Optimistic in the UI, never in the model: the toggle moves at once, and
   * `actualMode` still reports what the box last said. If the box refuses,
   * the toggle snaps back to the truth.
   */
  async setMode(mode: SiteMode): Promise<void> {
    if (mode === this.actualMode) return

    this.#clearTimer()
    this.command = { kind: 'sending', mode }

    try {
      const result: CmdResult = await this.#site.command(OP_SET_MODE, { mode })

      switch (result.state) {
        case 'applied':
          this.command = { kind: 'applied', mode }
          // The plan is a function of the mode, so it is now wrong on screen —
          // and the box replans in the background, so one reload can race the
          // optimizer and fetch the old plan again. Follow until the revision
          // moves, then stop; a bounded follow, because an optimizer that
          // never finishes must not leave a poller running forever.
          void this.#followPlan()
          break
        case 'unconfirmed':
          // The box took it; the hardware has not said so. Neither a success
          // nor a failure, and the user is told exactly that.
          this.command = { kind: 'unconfirmed', mode }
          break
        default:
          this.command = { kind: 'failed', help: commandHelp(result) }
      }
    } catch (err) {
      this.command = {
        kind: 'failed',
        help: err instanceof CommandError ? err.help : "That didn't go through. Try again.",
      }
    }

    this.#settleLater()
  }

  destroy(): void {
    this.#clearTimer()
  }

  #settleLater(): void {
    this.#clearTimer()
    this.#timer = setTimeout(() => {
      this.command = { kind: 'idle' }
      this.#timer = null
    }, SETTLE_MS)
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }
}

