<!--
  Box — which box this is, and how to leave it.

  The app had no way out. Everything else here is a glance at a house; this is
  the one screen that is about the pairing itself, and it exists because an app
  you cannot sign out of is not an app.

  It is not a preferences screen and must not become one. What it holds is what
  someone leaving needs to know — which box this phone is paired to, what it
  runs, when this phone joined, and the name to look for on the box's own list
  — and the door.

  What can be turned on here is what belongs to the pairing itself, not a
  settings list. Whether Sourceful holds a sealed copy of this home, so a
  phone that is lost or wiped can come back with the passkey alone — the
  mirror image of signing out, answered in the same words on the same screen,
  which is why it is not on the pairing flow: that flow's whole budget is two
  taps, and a privacy question is not worth the third for someone who has not
  lost a phone yet. And whether this box can reach this phone when the app is
  closed — notifications — which is the same relationship read the other way,
  and is undone by the same door.

  Nothing else may be set here. The next switch someone wants to add is how
  this becomes the settings screen the app does not have.

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
  import Access from '$views/Access.svelte'
  import Notifications from '$views/Notifications.svelte'

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
    /**
     * The shell's word that the last sign-out attempt failed.
     *
     * A failed leave tears every view down and puts the home back, this
     * screen included, so the failure cannot live in this screen's own
     * state — the instance that met it is gone. Opening on the same
     * sentence it would have shown beats a Sign out button pretending
     * nothing happened.
     */
    stuck?: boolean
  }

  let { site, leave, stuck = false }: Props = $props()

  type Stage = 'idle' | 'confirming' | 'leaving' | 'stuck'
  // Read once at construction, on purpose: the shell's word is about how
  // this instance opens, not a value to follow afterwards.
  // svelte-ignore state_referenced_locally
  let stage = $state<Stage>(stuck ? 'stuck' : 'idle')

  /**
   * Whether Sourceful is holding a sealed copy of this home.
   *
   * Read from the row rather than asked of the service, because asking would
   * cost a passkey prompt to answer a question about a screen — the id is
   * derived from the passkey and from nothing else. The row is what this
   * device believes, and it is what the next save acts on.
   */
  let copyKept = $state(false)
  /** 'working' while a prompt or a request is in flight. */
  let copyStage = $state<'idle' | 'working' | 'failed'>('idle')
  let copyProblem = $state('')

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
      copyKept = row.escrow === true
      name = await boxFingerprint(row.boxStaticKey)
    })()
  })

  /**
   * Ask Sourceful to hold a copy, or to stop holding one.
   *
   * The mark goes down first and comes back up if the write did not land, so
   * "Sourceful is holding a copy" on this screen is never further ahead than
   * what is actually out there. One passkey prompt either way — the id and
   * the key come out of the same ceremony.
   */
  async function setCopyKept(on: boolean) {
    const id = site.siteId
    if (!id) return
    copyStage = 'working'
    copyProblem = ''
    try {
      const [{ markEscrowed, saveEscrowCopy }, { openVaultStore, unlockWrappingKey }] =
        await Promise.all([import('$lib/identity/escrow'), import('$lib/identity/vault')])
      await markEscrowed(id, on)
      const store = openVaultStore()
      const outcome = await saveEscrowCopy(store, await unlockWrappingKey(store))
      if (outcome === 'saved' || outcome === 'cleared') {
        copyKept = on
        copyStage = 'idle'
        return
      }
      await markEscrowed(id, !on)
      copyStage = 'failed'
      // Three endings and three sentences, because "try again when you're
      // online" is wrong and unanswerable for a phone with no passkey that can
      // seal anything.
      copyProblem =
        outcome === 'unsupported'
          ? 'This phone has no passkey that can seal a copy. Everything else works exactly as it does now.'
          : outcome === 'unreachable'
            ? "That didn't reach Sourceful. Your home works either way — try again when you're back online."
            : "That didn't work. Your home works either way. Try again."
    } catch (err) {
      await markEscrowedQuietly(id, !on)
      // A dismissed passkey sheet is not a fault and gets no error voice.
      copyStage = err instanceof DOMException && err.name === 'NotAllowedError' ? 'idle' : 'failed'
      if (copyStage === 'failed') copyProblem = "That didn't work. Try again."
    }
  }

  async function markEscrowedQuietly(id: string, on: boolean) {
    try {
      const { markEscrowed } = await import('$lib/identity/escrow')
      await markEscrowed(id, on)
    } catch {
      // The mark is this device's belief about a copy; a stale one costs a
      // wrong sentence on this screen and is put right by the next attempt.
    }
  }

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

  /**
   * Sign out: this phone forgets its key and stops showing the home.
   *
   * The sealed copy is left exactly where it is. It is locked to this
   * household's passkey — only that passkey derives the id and the key that
   * open it — so keeping it across a sign-out is the way back, not a leak:
   * whoever holds the phone next cannot open it without the passkey, and its
   * owner can. Removing it is its own deliberate act — the sealed-copy switch
   * above — the way deleting an account is not a side effect of logging out
   * of it. This used to empty the copy here, which quietly undid the whole
   * point of holding one.
   */
  async function signOut() {
    await finishSignOut()
  }

  async function finishSignOut() {
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
  <h1>Your FTW Box</h1>
  <!-- Only once it can be named. A dash held the space while the key was
       being read, which reads as "your box has no name" rather than as a
       screen still filling in — and it is the first thing on the screen. -->
  {#if name}
    <p class="ident">
      <span class="num">{name}</span>
    </p>
  {/if}

  <dl>
    <div><dt>Web app</dt><dd class="num">{__APP_BUILD__}</dd></div>
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

  <!-- Who else this box trusts. The same question signing out asks, from the
       other end, which is why it lives on this screen and not a new one. -->
  <Access {site} />

  <hr />

  <!-- Whether this box can reach this phone when the app is closed. A fact
       about the pairing, like the roster above it. -->
  <Notifications {site} />

  <hr />

  <!-- The spare key. Written as what it costs, not as a feature: someone who
       says no must be able to see that they are choosing today's behaviour,
       and someone who says yes must be able to see what they are moving. -->
  <h2>If you lose this phone</h2>
  {#if copyKept}
    <p>
      Sourceful holds a sealed copy it cannot open, with an opaque id and
      nothing beside it. A new phone gets this home back with your passkey
      alone.
    </p>
    <p>
      Which also means your passkey is enough to open this home, on any device
      that can pass Face ID for it.
    </p>
    <button class="quiet outline" disabled={copyStage === 'working'} onclick={() => void setCopyKept(false)}>
      {copyStage === 'working' ? 'Removing the copy' : 'Remove the copy'}
    </button>
  {:else}
    <p>
      No sealed recovery copy is saved for this home right now. FTW normally
      makes one when you pair on a phone that supports passkey recovery.
      Sourceful can hold that copy without opening it, with an opaque id and
      nothing beside it, so a new phone gets this home back with your passkey.
    </p>
    <p>
      The cost: your passkey is then enough to open this home, on any device
      that can pass Face ID for it. Nothing is saved unless you ask.
    </p>
    <button class="quiet outline" disabled={copyStage === 'working'} onclick={() => void setCopyKept(true)}>
      {copyStage === 'working' ? 'Saving a sealed copy' : 'Keep a sealed copy'}
    </button>
  {/if}
  {#if copyStage === 'failed'}
    <p class="problem">{copyProblem}</p>
  {/if}

  <hr />

  {#if stage === 'confirming'}
    <h2>Sign out on this phone?</h2>
    <p>
      This phone stops showing your home and forgets its key. Nothing is removed
      from your box — it keeps running and keeps every reading.
    </p>
    {#if copyKept}
      <!-- The copy stays, so coming back is the passkey, not the box code.
           Removing it is the switch above, on purpose and not here. -->
      <p>
        The sealed copy stays, so you can open this home again with your
        passkey. To remove it instead, turn off the sealed copy above before you
        sign out.
      </p>
    {:else}
      <p>
        To come back, open the box's local dashboard and use Settings → FTW app
        → Show pairing code.
      </p>
    {/if}
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
