<!--
  The one-time iOS home screen hint.

  iOS gives a page no way to open the Share sheet, so the only honest thing to
  do is name the two taps and get out of the way. It sits at the bottom, over
  the home indicator, where it covers nothing and is next to the button it is
  talking about.

  Shown once per device and never again — dismissed or not. A hint that
  returns is a nag, and a nag about a thing the user has already decided not to
  do is worse than no hint at all.
-->
<script lang="ts">
  import { currentEnvironment, hintAlreadySeen, isIosSafariTab, markHintSeen } from '$lib/pwa/install'

  // Decided once, before any state exists. Neither answer can change without a
  // new page load, and "seen" is recorded on sight rather than on dismissal —
  // closing the app instead of tapping Close is also an answer.
  const offer = !hintAlreadySeen() && isIosSafariTab(currentEnvironment())
  if (offer) markHintSeen()

  let open = $state(offer)
</script>

{#if open}
  <div class="hint" role="note">
    <p>
      Add FTW to your home screen — tap
      <span class="key">Share</span>, then <span class="key">Add to Home Screen</span>. It opens
      instantly and keeps your readings between visits.
    </p>
    <!-- Named by its visible text alone: someone steering by voice says the
         word they can see, and an aria-label saying anything else breaks
         "tap Close". -->
    <button onclick={() => (open = false)}>Close</button>
  </div>
{/if}

<style>
  .hint {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom));
    background: var(--surface-elevated);
    border-top: 1px solid var(--line);
  }

  p {
    flex: 1;
    font-size: 13px;
    line-height: 1.45;
    color: var(--fg-dim);
  }

  .key {
    color: var(--fg-label);
    font-weight: 600;
  }

  button {
    flex: none;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
    padding: 0 var(--space-2);
  }
</style>
