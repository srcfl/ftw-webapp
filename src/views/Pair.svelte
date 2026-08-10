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
  import { BOX_CODE_CHARS, foldBoxCode, groupBoxCode } from '$lib/identity/boxcode'

  interface Props {
    onPaired: (site: PairedSite) => void
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
     * with. That distinction decides what may be offered here, because two of
     * the three ways in need something this phone is missing. See
     * $lib/state/connect, which owns the sentence.
     */
    problem?: string | null
    /** Back to the home this screen was opened from. Null when there is none. */
    dismiss?: (() => void) | null
  }

  let { onPaired, fragment = null, problem = null, dismiss = null }: Props = $props()

  /**
   * Running in an iOS browser tab rather than from the home screen.
   *
   * Decided once: neither answer can change without a new page load. Unlike
   * the app-wide hint this is not shown once and then never again — someone
   * setting up their home is exactly who needs to install first, and they
   * may well come back to this screen more than once before they finish.
   */
  const inSafariTab = isIosSafariTab(currentEnvironment())

  type Stage = 'intro' | 'scanning' | 'typing' | 'pairing' | 'error' | 'recovering' | 'choosing'

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
   * A key and a row are what the two quick ways in need: opening the home
   * again, and spending eight characters read off the box. With a `problem`
   * neither can work — a typed code writes bytes no handshake can spend, and
   * "Open Home" lands straight back on the screen it came from — so both go,
   * and what is left are the two ways that carry the missing part with them:
   * a scan, and the sealed copy.
   */
  const canOpen = $derived(known !== null && problem === null)

  let message = $state('')
  let video = $state<HTMLVideoElement | null>(null)
  let handle: ScanHandle | null = null

  onDestroy(() => handle?.stop())

  /**
   * A link is an offer, never an instruction.
   *
   * This used to pair the moment a fragment arrived. A link is something
   * anyone can send — by SMS, by email, on a sticker over the real QR — so
   * "your box needs re-pairing, tap here" silently repointed the app at the
   * sender's box: their readings shown as this home, every mode change sent
   * to their hardware, and no way back without finding the physical code
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
    stage = 'scanning'
    message = ''

    // Wait a frame so the <video> exists before the camera is asked for.
    await Promise.resolve()
    if (!video) return

    try {
      handle = await scanForEnrollment(video, (raw) => void pair(raw))
    } catch (err) {
      handle = null
      stage = 'error'
      message =
        err instanceof ScanError ? err.userMessage : "The camera didn't start. Try again."
    }
  }

  /**
   * The eight characters somebody is reading out over the phone.
   *
   * Held folded — I and L are already 1, O is already 0, the hyphen and any
   * spaces are gone — so what the field shows is what will be sent. Folding
   * as they type rather than when they press the button is the point: the box
   * burns a code after five wrong tries, and a try must never be spent on
   * something this app could read correctly itself.
   */
  let code = $state('')
  let codeProblem = $state('')

  const codeReady = $derived(code.length === BOX_CODE_CHARS)

  function onCodeInput(event: Event) {
    const field = event.currentTarget as HTMLInputElement
    code = foldBoxCode(field.value)
    // Written back so the grouping and the folding are visible rather than
    // implied. Setting `value` puts the caret at the end, which is where it
    // already is for anyone typing a code they are hearing.
    field.value = groupBoxCode(code)
    codeProblem = ''
  }

  /**
   * Spend the code on the next handshake.
   *
   * Only ever for a home this phone already holds — `known` is the whole
   * precondition, and it is why the button that leads here appears nowhere
   * else. The box's own page says the same: a code is for a phone that has
   * been here before, because only the square carries what a stranger needs.
   */
  async function useCode() {
    if (!known || !codeReady) return
    stage = 'pairing'
    try {
      const { redeemBoxCode } = await import('$lib/identity/pairing')
      await redeemBoxCode(known.siteId, code)
      onPaired({ siteId: known.siteId } as PairedSite)
    } catch (err) {
      stage = 'typing'
      const help = (err as { help?: unknown } | null)?.help
      codeProblem =
        typeof help === 'string' ? help : "That didn't work. Ask your box for a new code."
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
   * nothing held at all — which is the ordinary answer for a passkey that
   * never opted in, and not a fault — and a copy that will not open, which is
   * the one case where something is wrong and the box's own code is the way
   * back.
   */
  async function recover() {
    stage = 'recovering'
    message = ''
    try {
      const { recoverFromEscrow } = await import('$lib/identity/escrow')
      held = await recoverFromEscrow()
      if (held.length === 0) {
        stage = 'intro'
        message = 'Nothing was saved for this passkey. Scan the code on your box instead.'
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
          : "That didn't work. Scan the code on your box instead."
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

  function cancel() {
    handle?.stop()
    handle = null
    stage = 'intro'
    message = ''
  }
</script>

<section class="pair">
  {#if stage === 'scanning'}
    <div class="viewfinder">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} muted autoplay playsinline></video>
      <div class="reticle" aria-hidden="true"></div>
    </div>
    <p class="hint">Point at the code on your box.</p>
    <button class="quiet" onclick={cancel}>Cancel</button>
  {:else if stage === 'typing'}
    <!-- The floor that always works: no camera, a cracked lens, or somebody
         reading eight characters down a phone from the box's own screen. -->
    <h1>Type the code from your box</h1>
    <p>
      Your box shows eight characters. Type them here to let this phone back
      in to {known?.label ?? 'your home'}.
    </p>

    <label class="field">
      <span>Code</span>
      <input
        class="num"
        value={groupBoxCode(code)}
        oninput={onCodeInput}
        onkeydown={(e) => {
          if (e.key === 'Enter') void useCode()
        }}
        autocapitalize="characters"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        inputmode="text"
        maxlength="9"
        placeholder="04HM-ASW9"
        aria-describedby="code-note"
      />
    </label>

    {#if codeProblem}
      <p class="problem">{codeProblem}</p>
    {/if}

    <button class="primary" disabled={!codeReady} onclick={() => void useCode()}>
      Let this phone in
    </button>
    <p class="hint" id="code-note">
      A code works once and lasts a few minutes. If your home does not come
      back, ask for a new one — five wrong tries stop the old code.
    </p>
    <button class="quiet" onclick={cancel}>Cancel</button>
  {:else if stage === 'pairing'}
    <h1>Connecting</h1>
    <p>Confirming it's really your box.</p>
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
        Check it matches the code on your box before continuing.
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
    <h1>{problem ? 'Get this phone back in' : canOpen ? 'Welcome back' : 'Connect your box'}</h1>
    <p>
      {#if problem}
        <!-- What happened, from the one file that knows. What to do about it
             is the buttons below, which are only ever the ones that work. -->
        {problem}
      {:else if canOpen}
        Your key is still on this phone — nothing to set up again.
      {:else}
        Scan the code on your FTW box. Everything stays between this app and
        your box — nothing readable passes through Sourceful.
      {/if}
    </p>

    {#if message}
      <p class="problem">{message}</p>
    {/if}

    {#if inSafariTab}
      <!-- Said here, on the screen someone actually lands on, and not as a
           strip at the foot of the app. On iOS this is not a nicety: a tab's
           storage is evicted after a week away, and notifications only reach
           an installed app — so a phone that never installs loses its cache
           on exactly the schedule that makes the app feel slow, and can
           never be told its car has finished charging. iOS gives a page no
           way to open the Share sheet, so naming the two taps is the whole
           of what can honestly be done. -->
      <div class="install">
        <p class="install-title">Add FTW to your home screen first</p>
        <p class="install-steps">
          Tap <span class="key">Share</span>, then
          <span class="key">Add to Home Screen</span>.
        </p>
        <p class="install-why">
          It opens instantly, keeps your readings between visits, and is the
          only way your box can notify you.
        </p>
      </div>
    {/if}

    {#if canOpen}
      <button class="primary" onclick={() => onPaired({ siteId: known!.siteId } as PairedSite)}>
        Open {known?.label}
      </button>
      <!-- Offered here and nowhere else, because here is the only place it
           can work. A box code carries no box key and no rendezvous secret,
           so it re-admits a phone that already holds those and can do nothing
           at all for one that does not — which is what the box's own page
           says rather than offering a path with no end. -->
      <button
        class="quiet"
        onclick={() => {
          stage = 'typing'
          code = ''
          codeProblem = ''
          message = ''
        }}>Your box won't let this phone in?</button
      >
      <p class="hint">
        Ask someone standing at {known?.label}'s box to show a code, and type
        it in here.
      </p>
    {/if}

    {#if canOpen}
      {#if canScan()}
        <!-- "Add another box" only where that is what it would do. From a home
             this phone cannot open, the same button is how it gets back into
             that same box, and calling it a second box would be a lie about
             which house is on the other side of it. -->
        <button class="quiet" onclick={startScan}>Add another box</button>
      {/if}
    {:else}
      <!-- The two ways in, side by side and weighted the same, because for
           somebody arriving they are the same size of question: is this box
           new to me, or have I been here before? Making one a button and the
           other a line of small text answered that question for them, and
           answered it wrong for everyone coming back to a phone whose storage
           was wiped. -->
      <div class="ways">
        {#if canScan()}
          <button class="way" onclick={startScan}>
            <span class="way-title">Scan the code on your box</span>
            <span class="way-note">First time here. Two taps and you are in.</span>
          </button>
        {/if}
        <!-- Asking costs a Face ID prompt, so it stays a thing someone
             presses rather than a check on arrival: nothing may stand in
             front of the first frame, and a passkey that never saved a copy
             is told so once, because it asked. -->
        <button class="way" onclick={() => void recover()}>
          <span class="way-title">I've set this up before</span>
          <span class="way-note">Open your home again with your passkey.</span>
        </button>
      </div>
      <p class="hint">
        Or point your phone's camera at the code on your box. It opens the
        same link.
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

  /* The one field in the app, and it exists because a camera can fail. Wide
     letter spacing and the numeric face because these eight characters are
     read out loud one at a time, and a 0 that could be an O is what the
     alphabet was chosen to prevent. */
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    max-width: 18rem;
  }

  .field span {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  input {
    width: 100%;
    min-height: 52px;
    padding: 0 var(--space-4);
    font-size: 24px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--fg);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }

  input::placeholder {
    color: var(--fg-muted);
    /* The example, not a value. Same weight would read as a code already
       typed in a field somebody is being asked to type into. */
    opacity: 0.6;
  }

  .primary:disabled {
    opacity: 0.4;
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

  /* The two doors in, weighted the same. Neither is the recommended one:
     which fits depends on something only the person holding the phone
     knows, so the screen asks rather than steers. */
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
