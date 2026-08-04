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

  plan = $state<Plan | null>(null)
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

  get canControl(): boolean {
    return this.#site.session.caps.has('plan.dispatch')
  }

  async load(): Promise<void> {
    this.loading = true
    this.problem = null
    try {
      this.plan = await this.#site.plan()
    } catch {
      // A plan the box could not send is not a broken app. The view keeps
      // whatever it had and says the one useful thing.
      this.problem = "Couldn't reach your box for the plan. It'll load when it's back."
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
          // The plan is a function of the mode, so it is now wrong on screen.
          void this.load()
          break
        case 'unconfirmed':
          // The box took it; the hardware has not said so. Neither a success
          // nor a failure, and the user is told exactly that.
          this.command = { kind: 'unconfirmed', mode }
          break
        default:
          this.command = { kind: 'failed', help: helpFor(result) }
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

/** Stable codes in, sentences out. The box never writes prose. */
function helpFor(result: CmdResult): string {
  switch (result.error?.code) {
    case 'E_PRECONDITION':
      return 'Your home changed while that was sending. Have another go.'
    case 'E_CONFLICT':
      return 'Something else changed the setting first. Try again.'
    case 'E_SCOPE_DENIED':
      return "You don't have permission to change how this home runs."
    case 'E_CMD_EXPIRED':
      return 'That took too long to reach your box. Try again.'
    case 'E_BOOTING':
      return 'Your box is still starting. Give it a minute.'
    default:
      return "That didn't go through. Try again."
  }
}
