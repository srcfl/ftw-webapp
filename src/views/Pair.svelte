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
  }

  let { onPaired }: Props = $props()

  type Stage = 'intro' | 'scanning' | 'pairing' | 'error'

  let stage = $state<Stage>('intro')
  let message = $state('')
  let video = $state<HTMLVideoElement | null>(null)
  let handle: ScanHandle | null = null

  onDestroy(() => handle?.stop())

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
  {:else}
    <h1>Connect your box</h1>
    <p>
      Scan the code on your FTW box. Everything stays between this app and your
      box — nothing readable passes through Sourceful.
    </p>

    {#if message}
      <p class="problem">{message}</p>
    {/if}

    {#if canScan()}
      <button class="primary" onclick={startScan}>Scan code</button>
    {:else}
      <p class="hint">
        Point your phone's camera at the code on the box. It opens the same
        link.
      </p>
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
