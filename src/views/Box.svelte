<!--
  Box — which box this is, and how to leave it.

  The app had no way out. Everything else here is a glance at a house; this is
  the one screen that is about the pairing itself, and it exists because an app
  you cannot sign out of is not an app.

  It is not a preferences screen and must not become one. Nothing here can be
  set. What it holds is what someone leaving needs to know — which box this
  phone is paired to, what it runs, when this phone joined, and the name to
  look for on the box's own list — and the door.

  The two halves of leaving are kept apart on purpose. Signing out clears this
  phone; it does not tell the box to stop trusting it. Nothing on the wire can
  say that: the app protocol sends hello, sub, three queries and one command,
  and that command sets the mode. Even if it could, a sign-out that only
  worked while the box was reachable would not be a sign-out — and a phone is
  most often given away exactly where its box is not. So the screen says which
  half it is doing and where the other half is carried out, rather than
  implying it has done both.
-->
<script lang="ts">
  import type { SiteStore } from '$lib/state/site.svelte'
  import { boxFingerprint, pairedSites } from '$lib/identity/pairing'
  import { deviceIdOnBox, openVaultStore } from '$lib/identity/vault'

  interface Props {
    site: SiteStore
    /**
     * Stop this home and clear it from this phone.
     *
     * The shell's, not this screen's: the session and the feed have to be
     * stopped before the disk is touched, and this screen owns neither.
     * Rejects with the home still on the phone and still working.
     */
    leave: () => Promise<void>
  }

  let { site, leave }: Props = $props()

  type Stage = 'idle' | 'confirming' | 'leaving' | 'stuck'
  let stage = $state<Stage>('idle')

  /**
   * The box's name, offline.
   *
   * From the stored row rather than the session, because the screen has to
   * name the box whether or not it can be reached — and being unreachable is
   * one of the reasons someone opens it.
   */
  let name = $state<string | null>(null)
  let pairedAtMs = $state<number | null>(null)
  let deviceId = $state<string | null>(null)

  $effect(() => {
    const id = site.siteId
    void (async () => {
      const [sites, listedAs] = await Promise.all([
        pairedSites(),
        deviceIdOnBox(openVaultStore()),
      ])
      deviceId = listedAs
      // Matched by id, and never falling back to whichever row comes first.
      // The one job of this screen is to say which box this is; naming a
      // different one, with its pairing date under it, is worse than naming
      // none — and the door out works either way.
      const row = sites.find((s) => s.siteId === id)
      if (!row) return
      pairedAtMs = row.addedAtMs
      name = await boxFingerprint(row.boxStaticKey)
    })()
  })

  const build = $derived(site.session.box?.build ?? null)
  const timeZone = $derived(site.session.box?.tz ?? null)

  const pairedOn = $derived(
    pairedAtMs === null
      ? null
      : new Intl.DateTimeFormat(undefined, {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        }).format(pairedAtMs)
  )

  async function signOut() {
    stage = 'leaving'
    try {
      await leave()
      // Nothing after this: the shell has replaced the home, and this screen
      // goes with it.
    } catch {
      // The rows are still on the disk, so this phone is still paired and the
      // shell has put the home back. Saying so beats a pairing screen for a
      // home that never left.
      stage = 'stuck'
    }
  }
</script>

<section class="box">
  <h1>Your box</h1>
  <!-- Only once it can be named. A dash held the space while the key was
       being read, which reads as "your box has no name" rather than as a
       screen still filling in — and it is the first thing on the screen. -->
  {#if name}
    <p class="ident">
      <span class="num">{name}</span>
    </p>
  {/if}

  <dl>
    {#if build}
      <div><dt>Software</dt><dd class="num">{build}</dd></div>
    {/if}
    {#if timeZone}
      <div><dt>Time zone</dt><dd>{timeZone}</dd></div>
    {/if}
    {#if pairedOn}
      <div><dt>Paired</dt><dd>{pairedOn}</dd></div>
    {/if}
    {#if deviceId}
      <!-- The name to look for on the box's own list. Worked out from this
           phone's own key rather than asked for, so it is here exactly when
           the box is out of reach — which is when someone leaving needs it. -->
      <div><dt>This phone</dt><dd class="num">{deviceId}</dd></div>
    {/if}
  </dl>

  <hr />

  {#if stage === 'confirming'}
    <h2>Sign out on this phone?</h2>
    <p>
      This phone stops showing your home and forgets its key. Nothing is removed
      from your box — it keeps running and keeps every reading.
    </p>
    <p>To come back you need to scan the code on the box itself.</p>
    <!-- What to check, not what is certainly there. A device key that never
         finished pairing was never recorded, and a phone removed on the box
         already is gone from it — in both cases "your box will still list this
         phone as X" sent someone hunting for a row that does not exist. -->
    <p>
      Signing out here does not remove this phone from your box. If you are
      handing the phone on, remove it there too: Settings, then FTW app{#if deviceId}{', '}looking
        for <span class="num">{deviceId}</span>{/if}.
    </p>

    <button class="danger" onclick={() => void signOut()}>Sign out</button>
    <button class="quiet" onclick={() => (stage = 'idle')}>Cancel</button>
  {:else if stage === 'leaving'}
    <h2>Signing out</h2>
    <p>Clearing this home from this phone.</p>
  {:else if stage === 'stuck'}
    <h2>That didn't finish</h2>
    <p>
      Your home is still on this phone and still works. Try signing out again.
    </p>
    <button class="danger" onclick={() => (stage = 'confirming')}>Try again</button>
  {:else}
    <h2>Sign out</h2>
    <p>
      Clears this home from this phone. Your box and its readings are not
      touched.
    </p>
    <button class="quiet outline" onclick={() => (stage = 'confirming')}>Sign out</button>
  {/if}
</section>

<style>
  .box {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-6) var(--space-4) var(--space-7);
    max-width: 34rem;
  }

  h1 {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  .ident {
    font-size: 28px;
    letter-spacing: -0.01em;
    color: var(--fg);
  }

  h2 {
    font-size: 17px;
    font-weight: 500;
    letter-spacing: -0.01em;
    margin-top: var(--space-2);
  }

  p {
    color: var(--fg-dim);
    max-width: 30rem;
  }

  dl {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    font-size: 13px;
  }

  dl div {
    display: flex;
    gap: var(--space-3);
    justify-content: space-between;
  }

  dt {
    color: var(--fg-muted);
  }

  dd {
    color: var(--fg-dim);
    text-align: right;
  }

  hr {
    width: 100%;
    height: 1px;
    border: 0;
    background: var(--line-soft);
    margin: var(--space-3) 0 0;
  }

  .quiet {
    color: var(--fg-dim);
    font-size: 14px;
  }

  .outline {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-4);
  }

  /* The colour the app already uses for a reading that needs attention, not a
     red invented for this one button. */
  .danger {
    border: 1px solid var(--fresh-stale);
    color: var(--fresh-stale);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-5);
    font-weight: 500;
  }
</style>
