<!--
  Who can see this home.

  On the Box screen because that is the screen about the pairing itself, and
  sharing is the same question as signing out asked from the other end: which
  phones this box trusts.

  A viewer's app draws none of this. Hiding a control is presentation and the
  box refuses the request behind it either way — but showing someone a button
  that will be refused is the thing this app must not do, and the roster is
  not a viewer's to see. A viewer is told plainly what they have instead.

  There is no "make this person an owner" here, deliberately. An owner is
  admitted by the code on the box, in the house; promoting someone remotely is
  a bigger power than this screen should hold.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { askWhenLive } from '$lib/state/ask.svelte'
  import { AccessStore, roleLabel } from '$lib/state/access.svelte'
  import { ROLE_OWNER } from '$lib/protocol/messages'
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
  }

  let { site }: Props = $props()

  /** From contract/registry.yaml. Absent means this box has no passthrough. */
  const CAP_PASSTHROUGH = 'api.passthrough'

  const access = new AccessStore(untrack(() => site))

  // Which phone is this one. A local read, so it never waits on the box.
  void access.identify()

  const canManage = $derived(site.canConfigure && site.session.caps.has(CAP_PASSTHROUGH))

  // Asked when the session is up, again when it comes back, and again after
  // an ask the box could not answer. Nothing is asked at all when this phone
  // is not allowed to see the list.
  askWhenLive(
    untrack(() => site),
    () => (canManage ? 'members' : null),
    () => access.load()
  )

  /** Which phone is being confirmed for removal. Null when none. */
  let confirming = $state<string | null>(null)

  const members = $derived(access.members)
  const owners = $derived(members.filter((m) => m.role === ROLE_OWNER).length)

  function seen(ms: number | null): string {
    if (ms === null || ms <= 0) return 'not seen yet'
    const since = Date.now() - ms
    if (since < 120_000) return 'here now'
    if (since < 3_600_000) return `${Math.round(since / 60_000)} min ago`
    if (since < 86_400_000) return `${Math.round(since / 3_600_000)} h ago`
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(ms)
  }

  const inviteExpires = $derived.by(() => {
    const at = access.invite?.expiresAtMs
    if (!at) return null
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(at)
  })
</script>

<h2>Who can see this home</h2>

{#if !site.heardFromBox}
  <!-- Nothing on this screen is known yet, so it says nothing. Both sentences
       below are facts about the box, and the box has not spoken: before its
       hello, `caps` is empty because nobody asked and `role` reads owner
       because that is what an old box means by silence. Rendered from those,
       this screen told every cold start that its box was too old to share, and
       told a viewer's phone it owned the house. -->
  <p>Reaching your box…</p>
{:else if !site.canConfigure}
  <!-- Honest about what this phone is, rather than a screen with everything
       greyed out. The box would refuse all of it anyway. -->
  <p>
    You have view-only access. You can see this home's readings; changing
    anything, and who else can see it, belongs to its owner.
  </p>
{:else if !site.session.caps.has(CAP_PASSTHROUGH)}
  <p>Sharing needs newer software on your box.</p>
{:else}
  <ul class="members">
    {#each members as member (member.id)}
      <li>
        <div class="who">
          <span class="num id">{member.id}</span>
          <span class="meta">
            {roleLabel(member.role)} · {seen(member.lastSeenMs)}{#if member.isThisPhone}
              · this phone{/if}
          </span>
        </div>

        <!-- The last owner cannot be removed. Refused at the box too, so this
             is the app agreeing with it rather than the app deciding it. -->
        {#if member.isThisPhone}
          <span class="meta">use Sign out</span>
        {:else if member.role === ROLE_OWNER && owners <= 1}
          <span class="meta">last owner</span>
        {:else if confirming === member.id}
          <span class="confirm">
            <button
              class="danger"
              disabled={access.busy === 'revoking'}
              onclick={() =>
                void access.revoke(member.id).then((gone) => {
                  // Only on the box's own answer. Closing the confirmation
                  // over a refusal would look like it worked.
                  if (gone) confirming = null
                })}
            >
              Remove
            </button>
            <button class="quiet" onclick={() => (confirming = null)}>Cancel</button>
          </span>
        {:else}
          <button class="quiet outline" onclick={() => (confirming = member.id)}>Remove</button>
        {/if}
      </li>
    {:else}
      <!-- Three states, not two. A read that has not come back is not an empty
           house: this phone is on that list, so "nobody is paired" is a
           sentence the app can only say once the box has said it. It said it
           anyway for every dropped connection, and told an owner their own
           phone was not there. What went wrong is the sentence below the
           list; this one says only what is known. -->
      <li class="empty">
        {access.loading
          ? 'Reading your box…'
          : access.loaded
            ? 'No phones are paired with this box.'
            : 'The list has not come through yet. Still asking.'}
      </li>
    {/each}
  </ul>

  {#if access.invite}
    <p>
      Let the person joining point their camera at this. It lets them see this
      home and nothing else, and it works once{#if inviteExpires}, until
        {inviteExpires}{/if}.
    </p>
    <!-- A square and never text. What is in it is the box's static key, a
         live pairing code and the rendezvous secret — everything it takes to
         become a phone this house trusts — so the only path it may take is a
         camera. Printed as characters it can be read over a shoulder, copied
         into a message, or left in a screenshot, and the box's own page says
         so beside its own drawing.

         Loaded when there is something to draw. The encoder is a few
         kilobytes that one screen in the app needs once, and nothing that is
         not on the way to the first frame belongs in it. -->
    {#await import('$lib/ui/QrCode.svelte') then module}
      {@const QrCode = module.default}
      <QrCode text={access.invite.url} label="Pairing code for this home" />
    {:catch}
      <!-- The chunk never arrived. The invitation itself is fine — only the
           drawing is missing — so say what to do, not what broke. -->
      <p>The code didn't load — open this screen again to draw it.</p>
    {/await}
  {:else}
    <p>
      A viewer sees your readings and can change nothing. Making an invitation
      cancels any pairing code already showing on your box.
    </p>
    <button
      class="quiet outline"
      disabled={access.busy === 'inviting'}
      onclick={() => void access.inviteViewer()}
    >
      {access.busy === 'inviting' ? 'Asking your box' : 'Invite someone to view'}
    </button>
  {/if}

  {#if access.error}
    <p class="problem">{access.error}</p>
  {/if}
{/if}

<style>
  /* Svelte scopes a component's styles to that component, so the Box screen's
     headings and buttons stop at its own file. These repeat that screen's
     rules rather than reach into it, which is what keeps this component
     movable — and they are the same tokens, so the two halves of the screen
     stay one screen. */
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

  .danger {
    border: 1px solid var(--fresh-stale);
    color: var(--fresh-stale);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-4);
    min-height: 34px;
    font-weight: 500;
  }

  .members {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .members li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 40px;
  }

  .who {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .id {
    font-size: 14px;
    color: var(--fg);
  }

  .meta {
    font-size: 11px;
    color: var(--fg-muted);
  }

  .empty {
    font-size: 13px;
    color: var(--fg-muted);
  }

  .confirm {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

</style>
