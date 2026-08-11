<!--
  Pairing — the first thing anyone sees.

  Two taps: scan, Face ID. No fields, no code to type, no account, no choice.
  Everything that can fail does so before the passkey prompt, because asking
  for Face ID and then saying "wrong code" teaches people not to trust the
  flow.
-->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { canScan, scanForEnrollment, ScanError, type ScanHandle } from '$lib/identity/scan'
  import { currentEnvironment, isIosSafariTab } from '$lib/pwa/install'
  import { boxFingerprint, pairWithBox, type PairedSite } from '$lib/identity/pairing'
  import { EnrollmentError } from '$lib/identity/enrollment'

  interface Props {
    onPaired: (site: PairedSite) => void
    /** Open the public simulator without pairing or writing a home to disk. */
    onTryDemo?: (() => void | Promise<void>) | null
    /**
     * A pairing link the app was opened with.
     *
     * The camera on a phone opens the QR's URL in the browser rather than
     * handing it back to a page, so arriving with a fragment already in hand
     * is the ordinary path on iOS — not an edge case.
     */
    fragment?: string | null
    /**
     * Why this screen was opened, when it was opened from a home.
     *
     * Null on the ordinary path — a phone with nothing paired, or one whose
     * box has simply gone quiet. Set when no carrier could be built at all:
     * no key, no record of the home, no rendezvous secret to find the box
     * with. That distinction decides what may be offered here, because opening
     * the saved home needs something this phone is missing. See
     * $lib/state/connect, which owns the sentence.
     */
    problem?: string | null
    /** Back to the home this screen was opened from. Null when there is none. */
    dismiss?: (() => void) | null
  }

  let {
    onPaired,
    onTryDemo = null,
    fragment = null,
    problem = null,
    dismiss = null,
  }: Props = $props()

  /**
   * Running in an iOS browser tab rather than from the home screen.
   *
   * Decided once: neither answer can change without a new page load. Unlike
   * the app-wide hint this is not shown once and then never again — someone
   * setting up their home is exactly who needs to install first, and they
   * may well come back to this screen more than once before they finish.
   */
  const inSafariTab = isIosSafariTab(currentEnvironment())

  type Stage =
    | 'intro'
    | 'scanning'
    | 'pairing'
    | 'error'
    | 'recovering'
    | 'choosing'
    | 'demoing'

  let stage = $state<Stage>('intro')

  /**
   * Homes a sealed copy at Sourceful was holding for this passkey.
   *
   * Never fetched on arrival. Reading them costs a Face ID prompt, and a
   * prompt nobody asked for is the one thing this screen must not open with —
   * so it is a button, and someone who has never used the escrow never sees a
   * sheet at all. See $lib/identity/escrow.
   */
  let recovered = $state<{ siteId: string; label: string; fingerprint: string }[]>([])
  /** Index into `recovered`, kept apart from the objects the adopt path needs. */
  let held: import('$lib/identity/escrow').RecoveredHome[] = []

  /**
   * A device that is already enrolled and already knows a site.
   *
   * Reaching this screen in that state means something local went missing —
   * an evicted pointer, a fresh install that cannot see the browser tab's
   * storage — not that the phone is a stranger. Offering only "scan a code"
   * there asks the owner to mint a credential for a house their phone is
   * still holding the key to, and the box would rightly refuse the spent one
   * they last used. So: open it.
   */
  let known = $state<{ siteId: string; label: string } | null>(null)

  $effect(() => {
    void (async () => {
      const [{ openVaultStore, isEnrolled }, { pairedSites }] = await Promise.all([
        import('$lib/identity/vault'),
        import('$lib/identity/pairing'),
      ])
      if (!(await isEnrolled(openVaultStore()))) return
      const sites = await pairedSites()
      const first = sites[0]
      if (first) known = { siteId: first.siteId, label: first.label }
    })()
  })

  /**
   * Whether this phone can still open the home it holds.
   *
   * A key and a row are what opening the home again needs. With a `problem`
   * that path cannot work, so the two complete recovery paths remain: a new
   * pairing QR from FTW Settings, and the sealed copy opened by a passkey.
   */
  const canOpen = $derived(known !== null && problem === null)

  let message = $state('')
  let video = $state<HTMLVideoElement | null>(null)
  let handle: ScanHandle | null = null
  let scanAbort: AbortController | null = null

  onDestroy(() => {
    scanAbort?.abort()
    handle?.stop()
  })

  /**
   * A link is an offer, never an instruction.
   *
   * This used to pair the moment a fragment arrived. A link is something
   * anyone can send — by SMS, by email, on a sticker over the real QR — so
   * "your box needs re-pairing, tap here" silently repointed the app at the
   * sender's box: their readings shown as this home, every mode change sent
   * to their hardware, and no way back without opening a new pairing QR
   * again. On a device without PRF it cost the owner not one tap.
   *
   * So the fragment is parsed and shown, and nothing is trusted until
   * someone says so. Scanning a code with the camera is a deliberate act
   * already, so that path still pairs on the spot.
   */
  let offered = $state<{ fragment: string; fingerprint: string } | null>(null)

  $effect(() => {
    if (!fragment || stage !== 'intro') return
    void (async () => {
      const { parseEnrollmentFragment } = await import('$lib/identity/enrollment')
      try {
        const enrollment = parseEnrollmentFragment(fragment)
        // The same six characters the Box screen names a paired box by —
        // one function, so the box being offered and the box you have
        // cannot drift into being named two different ways.
        offered = { fragment, fingerprint: await boxFingerprint(enrollment.boxStaticPublic) }
      } catch {
        stage = 'error'
        message = 'That link is not an FTW pairing code.'
      }
    })()
  })

  async function startScan() {
    scanAbort?.abort()
    handle?.stop()
    const controller = new AbortController()
    scanAbort = controller
    stage = 'scanning'
    message = ''

    // Wait a frame so the <video> exists before the camera is asked for.
    await Promise.resolve()
    if (!video) return

    try {
      const next = await scanForEnrollment(video, (raw) => void pair(raw), controller.signal)
      if (controller.signal.aborted) {
        next.stop()
        return
      }
      handle = next
    } catch (err) {
      if (controller.signal.aborted) return
      handle = null
      stage = 'error'
      message =
        err instanceof ScanError ? err.userMessage : "The camera didn't start. Try again."
    }
  }

  async function pair(raw: string) {
    stage = 'pairing'
    try {
      const { site } = await pairWithBox(raw)
      onPaired(site)
    } catch (err) {
      stage = 'error'
      if (err instanceof EnrollmentError) {
        message = err.help
      } else if (err instanceof Error && err.name === 'NotAllowedError') {
        // The passkey sheet was dismissed. Not a fault, and not worth an
        // error voice — they can simply try again.
        stage = 'intro'
        return
      } else {
        message = "That didn't work. Try scanning again."
      }
    }
  }

  /**
   * Ask the passkey what Sourceful is holding.
   *
   * Three answers and they are nothing alike on screen: homes to choose from,
   * nothing held at all — which can happen when a save failed or the phone
   * could not make a recovery key — and a copy that will not open. In both
   * cases a new pairing QR is the way back.
   */
  async function recover() {
    stage = 'recovering'
    message = ''
    try {
      const { recoverFromEscrow } = await import('$lib/identity/escrow')
      held = await recoverFromEscrow()
      if (held.length === 0) {
        stage = 'intro'
        message =
          'Nothing was saved for this passkey. Open Settings → FTW app in your box dashboard and scan a new pairing code instead.'
        return
      }
      recovered = held.map((home) => ({
        siteId: home.siteId,
        label: home.label,
        fingerprint: home.fingerprint,
      }))
      stage = 'choosing'
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        // The sheet was dismissed. Not a fault and not worth an error voice.
        stage = 'intro'
        return
      }
      stage = 'intro'
      const help = (err as { help?: unknown } | null)?.help
      message =
        typeof help === 'string'
          ? help
          : "That didn't work. Open Settings → FTW app in your box dashboard and scan a new pairing code instead."
    }
  }

  async function adopt(index: number) {
    stage = 'pairing'
    try {
      const { adoptRecoveredHome } = await import('$lib/identity/escrow')
      const siteId = await adoptRecoveredHome(held[index]!)
      onPaired({ siteId } as PairedSite)
    } catch (err) {
      stage = 'error'
      const help = (err as { help?: unknown } | null)?.help
      message = typeof help === 'string' ? help : "That didn't work. Try scanning the code instead."
    }
  }

  async function tryDemo() {
    if (!onTryDemo) return
    stage = 'demoing'
    message = ''
    try {
      await onTryDemo()
    } catch {
      stage = 'intro'
      message = "The demo didn't load. Check your connection and try again."
    }
  }

  function cancel() {
    scanAbort?.abort()
    scanAbort = null
    handle?.stop()
    handle = null
    stage = 'intro'
    message = ''
  }
</script>

{#snippet demoOffer()}
  {#if onTryDemo}
    <section class="demo" aria-labelledby="demo-title">
      <p class="demo-label"><span aria-hidden="true"></span> Interactive demo</p>
      <h2 id="demo-title">See a home running</h2>
      <p>
        Explore live solar, battery, grid, EV charging, plans and history. The
        data is simulated and nothing is saved.
      </p>
      <button class="primary" onclick={() => void tryDemo()}>Try the live demo</button>
    </section>
  {/if}
{/snippet}

<section class="pair">
  {#if inSafariTab && (stage === 'intro' || stage === 'error')}
    <h1>Install FTW first</h1>
    <p>Add FTW to your Home Screen before you connect a box or restore a saved home.</p>
    {#if message}
      <p class="problem">{message}</p>
    {/if}
    <div class="install">
      <p class="install-title">Two taps in Safari</p>
      <p class="install-steps">
        Tap <span class="key">Share</span>, then
        <span class="key">Add to Home Screen</span>.
      </p>
      <p class="install-why">
        Open FTW from your Home Screen after that. It starts faster, keeps your
        readings between visits, and can receive notifications.
      </p>
    </div>
    {#if offered}
      <p class="hint">
        This pairing link stays inactive in Safari. After installing, open FTW
        from your Home Screen and scan the pairing QR again.
      </p>
    {/if}
    {@render demoOffer()}
  {:else if stage === 'scanning'}
    <div class="viewfinder">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} muted autoplay playsinline></video>
      <div class="reticle" aria-hidden="true"></div>
    </div>
    <p class="hint">
      In your box's local dashboard, open Settings → FTW app. Hold the pairing
      QR inside the frame.
    </p>
    <button class="quiet" onclick={cancel}>Cancel</button>
  {:else if stage === 'pairing'}
    <h1>Securing this phone</h1>
    <p>Confirm with Face ID or Touch ID if your phone asks.</p>
  {:else if stage === 'demoing'}
    <h1>Starting the demo</h1>
    <p>Loading a simulated home.</p>
  {:else if stage === 'recovering'}
    <h1>Checking</h1>
    <p>Asking your passkey what it can open.</p>
  {:else if stage === 'choosing'}
    <!-- Named by fingerprint as well as label, for the same reason the offer
         above a scanned link is: two homes with the same name are two
         different boxes, and only one of them is yours. -->
    <h1>{recovered.length === 1 ? 'Your home is here' : 'Pick a home to open'}</h1>
    <p>Your passkey opened a sealed copy. Nothing was sent to your box.</p>
    {#each recovered as home, index (home.siteId)}
      <button class="primary" onclick={() => void adopt(index)}>
        Open {home.label} <span class="num">{home.fingerprint}</span>
      </button>
    {/each}
    <button class="quiet" onclick={cancel}>Not now</button>
  {:else if offered}
    <!-- A link arrived. What it points at is shown before anything is
         trusted, and switching an already-paired app is named as what it is
         rather than happening quietly underneath. -->
    <h1>{known ? 'Connect to a different box?' : 'Connect this box?'}</h1>
    <p>
      This link points at box <span class="num">{offered.fingerprint}</span>.
      {#if known}
        Connecting it replaces {known.label} as the home this app shows and
        controls. Your key for {known.label} stays on this phone.
      {:else}
        Only continue if you just opened Settings → FTW app and chose Show
        pairing code in this box's local dashboard.
      {/if}
    </p>

    {#if message}
      <p class="problem">{message}</p>
    {/if}

    <button class="primary" onclick={() => void pair(offered!.fragment)}>
      {known ? `Connect ${offered.fingerprint}` : 'Connect this box'}
    </button>
    <button
      class="quiet"
      onclick={() => {
        offered = null
        history.replaceState(null, '', '/')
      }}>Not now</button
    >
  {:else}
    <h1>{problem ? 'Get this phone back in' : canOpen ? 'Welcome back' : 'Connect FTW'}</h1>
    <p>
      {#if problem}
        <!-- What happened, from the one file that knows. What to do about it
             is the buttons below, which are only ever the ones that work. -->
        {problem}
      {:else if canOpen}
        Your key is still on this phone — nothing to set up again.
      {:else}
        Connect your own box, open a home saved with your passkey, or try a
        live simulated home first.
      {/if}
    </p>

    {#if message}
      <p class="problem">{message}</p>
    {/if}

    {#if !problem && !dismiss && !canOpen && onTryDemo}
      {@render demoOffer()}
    {/if}

    {#if canOpen}
      <button class="primary" onclick={() => onPaired({ siteId: known!.siteId } as PairedSite)}>
        Open {known?.label}
      </button>
      {#if canScan()}
        <button class="quiet" onclick={startScan}>Scan a new pairing QR</button>
      {/if}
      <p class="hint">Use a new QR from Settings → FTW app if this key no longer works.</p>
    {/if}

    {#if !canOpen}
      <!-- Both complete paths are visible: a new box uses its Settings QR,
           while a saved home uses its passkey. -->
      <section class="setup" aria-labelledby="setup-title">
        <h2 id="setup-title">Connect your own box</h2>
        <p class="not-printed">
          The QR code is inside FTW Settings. It is not printed on the
          Raspberry Pi or its case.
        </p>
        <ol>
          <li>Open your box's local FTW dashboard while on your home network.</li>
          <li>Go to <span class="key">Settings → FTW app</span>.</li>
          <li>Tap <span class="key">Show pairing code</span>, then scan the QR here.</li>
        </ol>
        <p class="security-note">
          Next, a supported phone asks for Face ID or Touch ID to protect your
          FTW key. There is no FTW account or password. If that passkey supports
          recovery and the save reaches Sourceful, FTW keeps a sealed recovery
          copy that Sourceful cannot open. If not, pairing still works; a new
          Settings QR is the way back.
        </p>
        {#if canScan()}
          <button class="primary" onclick={startScan}>Scan the pairing QR</button>
        {/if}
        <details>
          <summary>Can't see Show pairing code?</summary>
          <p>
            Turn on <span class="key">Let the FTW app connect to this box</span>,
            save, and restart the box first.
          </p>
        </details>
      </section>

      <div class="ways">
        <!-- Asking costs a Face ID prompt, so it stays a thing someone
             presses rather than a check on arrival: nothing may stand in
             front of the first frame, and a passkey that never saved a copy
             is told so once, because it asked. -->
        <button class="way" onclick={() => void recover()}>
          <span class="way-title">Open with your passkey</span>
          <span class="way-note">
            Used FTW before? Ask Face ID or Touch ID for a saved home.
          </span>
        </button>
      </div>
      <p class="hint">
        You can also scan the QR with the phone's Camera app. It opens this
        same pairing flow.
      </p>
    {/if}

    <!-- A screen opened from a home has to lead back to it. Without this the
         way out of a dead end is a dead end of its own, one screen along —
         and the cached house is still worth looking at while the app keeps
         trying underneath. -->
    {#if dismiss}
      <button class="quiet" onclick={dismiss}>Not now</button>
    {/if}
  {/if}
</section>

<style>
  .pair {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-4);
    padding: var(--space-7) var(--space-4);
    max-width: 34rem;
  }

  h1 {
    font-size: 24px;
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }

  p {
    color: var(--fg-dim);
    max-width: 30rem;
  }

  .problem {
    color: var(--fg);
    border-left: 2px solid var(--energy-generation);
    padding-left: var(--space-3);
  }

  .hint {
    font-size: 13px;
  }

  .demo,
  .setup {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-4);
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .demo {
    border-color: color-mix(in oklch, var(--energy-export) 45%, var(--line));
    background:
      radial-gradient(circle at 100% 0%, color-mix(in oklch, var(--energy-export) 12%, transparent), transparent 55%),
      var(--surface-raised);
  }

  .demo h2,
  .setup h2 {
    font-size: 18px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  .demo-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--energy-export);
  }

  .demo-label span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--energy-export);
  }

  .not-printed {
    color: var(--fg-label);
  }

  .security-note {
    font-size: 13px;
    color: var(--fg-muted);
  }

  .setup ol {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-left: 1.25rem;
    color: var(--fg-dim);
  }

  details {
    width: 100%;
    color: var(--fg-dim);
    font-size: 13px;
  }

  summary {
    min-height: 44px;
    display: flex;
    align-items: center;
    cursor: pointer;
    color: var(--fg-dim);
  }

  details p {
    padding-bottom: var(--space-1);
    color: var(--fg-muted);
  }

  .primary {
    background: var(--accent);
    color: var(--on-accent);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-5);
    font-weight: 500;
  }

  .quiet {
    color: var(--fg-dim);
    font-size: 14px;
  }

  /* Said where someone lands, not at the foot of the app. It is an
     instruction rather than a warning, so it carries the accent edge the
     app uses for "here is the thing to do" and none of the alarm of a
     problem. */
  .install {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
    padding: var(--space-4);
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-left: 2px solid var(--accent);
    border-radius: var(--radius-md);
  }

  .install-title {
    font-size: 16px;
    font-weight: 500;
    color: var(--fg);
  }

  .install-steps {
    font-size: 15px;
    color: var(--fg-dim);
  }

  .install-why {
    font-size: 13px;
    color: var(--fg-muted);
  }

  .key {
    color: var(--fg-label);
    font-weight: 600;
  }

  /* The recovery action has the same card weight as box setup. */
  .ways {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
  }

  .way {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    width: 100%;
    padding: var(--space-4);
    text-align: left;
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .way-title {
    font-size: 16px;
    font-weight: 500;
    color: var(--fg);
  }

  .way-note {
    font-size: 13px;
    color: var(--fg-dim);
  }

  .viewfinder {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* A frame, not a scanner animation. The camera is already the feedback. */
  .reticle {
    position: absolute;
    inset: 18%;
    border: 2px solid var(--accent);
    border-radius: var(--radius-md);
  }
</style>
