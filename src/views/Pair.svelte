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
  import { pairWithBox, type PairedSite } from '$lib/identity/pairing'
  import { EnrollmentError } from '$lib/identity/enrollment'

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
  }

  let { onPaired, fragment = null }: Props = $props()

  type Stage = 'intro' | 'scanning' | 'pairing' | 'error'

  let stage = $state<Stage>('intro')

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
        offered = { fragment, fingerprint: await fingerprintOf(enrollment.boxStaticPublic) }
      } catch {
        stage = 'error'
        message = 'That link is not an FTW pairing code.'
      }
    })()
  })

  /**
   * A short, stable name for a box key.
   *
   * Six hex characters of its digest. Not a security control on its own —
   * nobody memorises it — but it makes two different boxes visibly
   * different, which is what a person needs to notice that the box being
   * offered is not the one on their wall.
   */
  async function fingerprintOf(key: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', key as BufferSource)
    return Array.from(new Uint8Array(digest).subarray(0, 3))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  }

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
  {:else if stage === 'pairing'}
    <h1>Connecting</h1>
    <p>Confirming it's really your box.</p>
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
    <h1>{known ? 'Welcome back' : 'Connect your box'}</h1>
    <p>
      {#if known}
        Your key is still on this phone — nothing to set up again.
      {:else}
        Scan the code on your FTW box. Everything stays between this app and
        your box — nothing readable passes through Sourceful.
      {/if}
    </p>

    {#if message}
      <p class="problem">{message}</p>
    {/if}

    {#if known}
      <button class="primary" onclick={() => onPaired({ siteId: known!.siteId } as PairedSite)}>
        Open {known.label}
      </button>
      <p class="hint">
        This phone is already set up for {known.label}. Adding a code is only
        for a different box.
      </p>
    {/if}

    {#if canScan()}
      <button class={known ? 'quiet' : 'primary'} onclick={startScan}>
        {known ? 'Add another box' : 'Scan code'}
      </button>
    {/if}
    <p class="hint">
      Or point your phone's camera at the code. It opens the same link.
    </p>
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
