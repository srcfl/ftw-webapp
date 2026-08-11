<!-- Box information for the public simulator.

     This component does not import identity, push, access or sign-out code.
     A demo must never read or clear a real phone's saved home. -->
<script lang="ts">
  import type { SiteStore } from '$lib/state/site.svelte'

  interface Props {
    site: SiteStore
    onExit: () => void
  }

  let { site, onExit }: Props = $props()

  const build = $derived(site.session.box?.build ?? null)
  const timeZone = $derived(site.session.box?.tz ?? null)
</script>

<section class="box">
  <h1>Demo home</h1>
  <p class="ident">Simulated FTW box</p>
  <p>
    This is the same app and protocol as a connected home. The readings and
    changes stay in this demo and reset when you leave.
  </p>

  <dl>
    <div><dt>Web app</dt><dd class="num">{__APP_BUILD__}</dd></div>
    {#if build}<div><dt>Software</dt><dd class="num">{build}</dd></div>{/if}
    {#if timeZone}<div><dt>Time zone</dt><dd>{timeZone}</dd></div>{/if}
    <div><dt>Data</dt><dd>Simulated</dd></div>
  </dl>

  <hr />

  <h2>Access</h2>
  <p>
    On a connected home, this screen lists owner and viewer phones. An owner
    can invite a viewer or remove access.
  </p>

  <hr />

  <h2>Notifications</h2>
  <p>
    An installed app can show useful events on the lock screen, such as a
    finished EV charge, an installed box update or a box that went quiet.
  </p>

  <hr />

  <h2>Passkey recovery</h2>
  <p>
    A real home can keep a sealed recovery copy for its passkey. Sourceful
    cannot open it, and the owner can remove it here.
  </p>

  <button class="primary" onclick={onExit}>Exit demo and connect your box</button>
</section>

<style>
  .box {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    max-width: 34rem;
    padding: var(--space-6) var(--space-4) var(--space-7);
  }

  h1 {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--energy-export);
  }

  .ident {
    font-size: 28px;
    letter-spacing: -0.01em;
    color: var(--fg);
  }

  h2 {
    margin-top: var(--space-2);
    font-size: 17px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  p {
    max-width: 30rem;
    color: var(--fg-dim);
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
    justify-content: space-between;
    gap: var(--space-3);
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
    margin: var(--space-3) 0 0;
    border: 0;
    background: var(--line-soft);
  }

  .primary {
    min-height: 44px;
    margin-top: var(--space-2);
    padding: 0 var(--space-5);
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 500;
  }
</style>
