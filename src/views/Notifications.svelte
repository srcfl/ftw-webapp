<!--
  Notifications — what this phone hears from this box when the app is closed.

  On the Box screen because it is a fact about the pairing, not a preference:
  the box holds this phone's endpoint the same way it holds its key, and
  leaving is where both are undone.

  One switch, then which kinds. The catalogue the box renders from is sparse
  by design — a household that mutes the app because it nagged has lost every
  notification that mattered — so the toggles are few and stay few.

  The permission prompt runs inside the tap that asked for it, because iOS
  grants it nowhere else. That forces the order: permission first, box
  second, so a box that turns out to be too old is discovered after the
  phone said yes. The history read doubles as the probe that finds an old
  box before the button is drawn, so that path is rarely met.

  A viewer's phone gets a sentence, not greyed-out controls: the box prices
  these routes as configuration, and drawing a button the box will refuse is
  the thing this app must not do.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { askWhenLive } from '$lib/state/ask.svelte'
  import { NotifyStore } from '$lib/state/notify.svelte'
  import { RULE_KINDS, KIND_LABELS } from '$lib/notify/kinds'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
  }

  let { site }: Props = $props()

  /** From contract/registry.yaml. Absent means this box has no passthrough. */
  const CAP_PASSTHROUGH = 'api.passthrough'

  const notify = new NotifyStore(untrack(() => site))

  // What this phone already is: support and a live subscription. Local reads,
  // so nothing here waits on the box.
  void notify.check()

  const canManage = $derived(site.canConfigure && site.session.caps.has(CAP_PASSTHROUGH))

  // The reads on this section, asked while the session is live and again
  // when it comes back. They fill the history and the rules document — both
  // priced Read, so looking costs no ceremony — and on an old box answer
  // E_UNKNOWN_OP, which is what keeps the enable button off a box that
  // would refuse it.
  askWhenLive(
    untrack(() => site),
    () => (canManage && notify.supported && !notify.oldBox ? 'push-history' : null),
    () => Promise.all([notify.loadHistory(), notify.loadRules()]).then(() => {})
  )

  /**
   * The unsaved toggle edits, or null when the switches show the box's own
   * document. One draft, one save, one ceremony — the schedule editor's rule.
   */
  let draft = $state<Record<string, boolean> | null>(null)

  // Off until the box's document says otherwise: the box seeds every rule
  // disabled — sparse by design — and a switch drawn on before the document
  // was read would promise a notification nobody arranged.
  const dirty = $derived(
    draft !== null &&
      RULE_KINDS.some((kind) => (draft?.[kind] ?? false) !== (notify.rules[kind] ?? false))
  )

  function shown(kind: string): boolean {
    return (draft ?? notify.rules)[kind] ?? false
  }

  function toggle(kind: string): void {
    const next = { ...(draft ?? notify.rules) }
    next[kind] = !(next[kind] ?? false)
    draft = next
  }

  async function save(): Promise<void> {
    if (draft === null) return
    if (await notify.saveRules(draft)) draft = null
  }

  function when(ms: number | null): string {
    if (ms === null || ms <= 0) return ''
    const since = Date.now() - ms
    if (since < 3_600_000) return `${Math.max(1, Math.round(since / 60_000))} min ago`
    if (since < 86_400_000) return `${Math.round(since / 3_600_000)} h ago`
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(ms)
  }
</script>

<h2>Notifications</h2>

{#if !notify.supported}
  <!-- A phone fact, said before any box fact: on iOS the push machinery only
       exists once the app is installed, and no box can change that. -->
  <p>
    Add this app to your home screen first — notifications can only reach a
    phone from there. Then come back to this screen and turn them on.
  </p>
{:else if !site.heardFromBox}
  <!-- Nothing below is known yet. Same rule as the sharing section above:
       before the box's hello, its capabilities and this phone's role are
       guesses, and a sentence built on a guess is a claim about the box. -->
  <p>Reaching your box…</p>
{:else if !site.canConfigure}
  <p>Notifications are turned on by this home's owner.</p>
{:else if !site.session.caps.has(CAP_PASSTHROUGH)}
  <p>Notifications need newer software on your box.</p>
{:else if notify.oldBox}
  <p>Your box doesn't have that yet — it may be running older software.</p>
{:else if notify.enabled}
  <p>Your box can reach this phone, even with the app closed.</p>

  <ul class="kinds">
    {#each RULE_KINDS as kind (kind)}
      <li>
        <label>
          <input
            type="checkbox"
            checked={shown(kind)}
            disabled={notify.busy !== 'none'}
            onchange={() => toggle(kind)}
          />
          <span>{KIND_LABELS[kind]}</span>
        </label>
      </li>
    {/each}
  </ul>
  <!-- box.unreachable has no switch of its own and cannot: the box cannot
       gate a message about its own absence. It follows the subscription —
       being enabled here is what turns it on. -->
  <p class="hint">{KIND_LABELS['box.unreachable']} is always on while this is enabled.</p>

  {#if dirty}
    <button class="quiet outline" disabled={notify.busy !== 'none'} onclick={() => void save()}>
      {notify.busy === 'saving' ? 'Saving…' : 'Save'}
    </button>
  {/if}

  <div class="actions">
    <button
      class="quiet outline"
      disabled={notify.busy !== 'none'}
      onclick={() => void notify.sendTest()}
    >
      {notify.busy === 'testing' ? 'Asking your box…' : 'Send a test'}
    </button>
    <button
      class="quiet outline"
      disabled={notify.busy !== 'none'}
      onclick={() => void notify.disable()}
    >
      {notify.busy === 'disabling' ? 'Turning off…' : 'Turn off notifications'}
    </button>
  </div>
  {#if notify.testSent}
    <p class="meta">Sent — it shows up on this phone in a moment.</p>
  {/if}

  {#if notify.history.length > 0}
    <ul class="history">
      {#each notify.history as row (row.title + row.atMs)}
        <li>
          <span class="sent">{row.title}</span>
          <span class="meta">{when(row.atMs)}</span>
        </li>
      {/each}
    </ul>
  {/if}
{:else}
  <p>
    A few words on the lock screen when something at home matters: the car is
    charged, your box updated itself, or it went quiet. Nothing is sent until
    you turn this on.
  </p>
  <button
    class="quiet outline"
    disabled={notify.busy !== 'none'}
    onclick={() => void notify.enable()}
  >
    {notify.busy === 'enabling' ? 'Turning on…' : 'Turn on notifications'}
  </button>
{/if}

{#if notify.error}
  <p class="problem">{notify.error}</p>
{/if}

<style>
  /* Svelte scopes styles to the component, so these repeat the Box screen's
     rules with the same tokens rather than reaching into it — what keeps the
     section movable while the two halves stay one screen. */
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

  .problem {
    color: var(--fresh-stale);
  }

  .quiet {
    color: var(--fg-dim);
    font-size: 14px;
  }

  .outline {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-4);
    min-height: 34px;
  }

  .kinds {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .kinds label {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 32px;
    color: var(--fg-dim);
    font-size: 14px;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .history {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .history li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .sent {
    font-size: 14px;
    color: var(--fg);
  }

  .meta {
    font-size: 11px;
    color: var(--fg-muted);
  }
</style>
