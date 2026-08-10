<!--
  App shell.

  Paints before any data arrives and never blocks on a network round trip.
  In development it attaches a simulated box so the whole client can be built
  without hardware; in production the carrier comes from enrollment.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import FreshnessBand from '$lib/ui/FreshnessBand.svelte'
  import InstallHint from '$lib/ui/InstallHint.svelte'
  import UpdateLine from '$lib/ui/UpdateLine.svelte'
  import Now from '$views/Now.svelte'
  import Plan from '$views/Plan.svelte'
  import Pair from '$views/Pair.svelte'
  import { SiteStore } from '$lib/state/site.svelte'
  import { Router } from '$lib/state/route.svelte'

  // Replaced wholesale when someone signs out. `$state.raw` rather than
  // `$state`, because what changes is which store the views read, never a
  // field inside it — the store owns its own reactivity.
  let site = $state.raw(new SiteStore(__APP_BUILD__))
  const router = new Router()

  /** Reserved for the development simulator so a real pairing never collides. */
  const SIM_SITE_ID = 'sim-0001'

  // Not awaited: the shell paints now, and cached readings land a frame or
  // two later. The read itself was started by the inline script in
  // index.html, before this bundle was even parsed.
  // The fast path. localStorage is a hint, not the record: it is read
  // synchronously so a warm launch paints without waiting on IndexedDB, and
  // the database is consulted right after in case this hint is missing —
  // which is exactly what happens to a freshly installed PWA that cannot see
  // the browser tab's localStorage, and to any install whose localStorage was
  // evicted while the sites survived.
  let siteId = $state<string | null>(readSiteHint())

  function readSiteHint(): string | null {
    try {
      return localStorage.getItem('ftw.site')
    } catch {
      // Blocked storage costs a slower start, never a broken launch.
      return null
    }
  }

  // Read once at startup, on purpose: this is the launch path, not a reaction
  // to a value that changes. Pairing calls start() itself.
  const initialSiteId = untrack(() => siteId)
  // Untracked for the same reason: the store only ever changes on a sign-out,
  // which happens long after the launch path has run and replaces the views
  // reading it anyway.
  if (initialSiteId) void untrack(() => site.start(initialSiteId))

  /**
   * The database is the record; localStorage only points at it.
   *
   * Without this a launch that has no hint shows the pairing screen even
   * though this device is paired and its key is in the vault — the state a
   * newly installed PWA starts in on iOS, where the standalone app does not
   * inherit the tab's localStorage. Recovering here means the install pairs
   * itself from what it already has instead of asking for a code the box
   * would rightly refuse.
   */
  /**
   * True while the database is still being asked whether this device is
   * paired. The pairing screen is a large, decisive thing to show someone;
   * flashing it for a frame before recovering would be worse than the bug it
   * replaces. The shell paints regardless — only the content area waits, and
   * only for a local read.
   */
  let resolvingSite = $state(!initialSiteId)

  if (!initialSiteId) {
    void (async () => {
      const { currentSiteId } = await import('$lib/identity/pairing')
      let recovered: string | null = null
      try {
        recovered = await currentSiteId()
      } finally {
        resolvingSite = false
      }
      if (!recovered || siteId) return
      siteId = recovered
      try {
        localStorage.setItem('ftw.site', recovered)
      } catch {
        /* the database still holds the record */
      }
      await site.start(recovered)
      await connect(site, recovered)
    })()
  }

  /**
   * Landing on a pairing link, from a camera or a shared URL.
   *
   * With nothing paired this is checked synchronously, so the pairing screen
   * is what paints. With a site already paired the home paints first and the
   * fragment is judged in the background: after a successful pairing the
   * /p#… URL is what the browser reloads and restores, carrying a code that
   * was spent the moment it worked — re-running it would show the owner a
   * pairing error for a house they are standing in. Only a fragment that
   * points at a *different* box is a genuine invitation.
   */
  const rawFragment = location.pathname === '/p' ? location.hash : null
  let pairingFragment = $state(initialSiteId ? null : rawFragment)

  if (rawFragment && initialSiteId) {
    void import('$lib/identity/landing').then(async ({ fragmentTarget }) => {
      const target = await fragmentTarget(rawFragment)
      if (target !== null && target !== initialSiteId) {
        pairingFragment = rawFragment
      } else {
        // Same box or nothing at all: a leftover, not an invitation.
        history.replaceState(null, '', '/')
      }
    })
  }

  /** Nothing paired and nothing cached: the only screen is pairing. */
  /**
   * Which views have ever been opened.
   *
   * A view is built the first time it is reached and kept from then on, so
   * the second visit is instant and keeps its state. Not built up front,
   * because nothing that has not been asked for belongs on the path to the
   * first frame.
   */
  let seen = $state({ plan: false, history: false, box: false })
  $effect(() => {
    if (router.current === 'plan') seen.plan = true
    if (router.current === 'history') seen.history = true
    if (router.current === 'box') seen.box = true
  })

  const needsPairing = $derived(!siteId && !site.paired && !resolvingSite)

  /**
   * Someone asked for the way back into a home this phone already has.
   *
   * The pairing screen is the floor: no other device, no session, nothing on
   * this phone that opens the house. It used to be mounted on one condition —
   * this phone is pointed at no home at all — which is false for every state
   * the floor exists for. A phone whose identity database was evicted while
   * its site row survived kept pointing at a home it could not open, and the
   * one screen that could put that right was the one it could never reach.
   *
   * Asked for, never imposed. Nothing here is broken enough to take the house
   * off the screen by itself: a cached reading with an honest age is still
   * worth looking at, and the app goes on trying underneath. See Now, which
   * is where the offer sits, and $lib/state/ask for everything that does heal
   * itself without asking anybody.
   */
  let recovering = $state(false)

  /** This phone is pointed at a home, whether or not one has painted yet. */
  const hasHome = $derived(site.paired || siteId !== null)

  /** Whatever is feeding the store: the development simulator, or nothing. */
  let stopFeed: (() => void) | undefined

  /** Development starts on the simulated box unless a real one is paired. */
  const useSimulator = import.meta.env.DEV && (!initialSiteId || initialSiteId === SIM_SITE_ID)

  /**
   * Point a store at its box.
   *
   * One function rather than a branch at every call site, because a home put
   * back after a sign-out the disk refused has to be fed exactly the way the
   * launch path feeds it — anything less leaves a house on screen that has
   * quietly stopped moving.
   *
   * Which box is decided by the id, not by how the app started: the simulator
   * has a reserved one, so a real pairing in the same browser takes the relay
   * path. The store is passed rather than read, so a feed can never attach
   * itself to whichever store happens to be current when its import lands.
   */
  function openFeed(store: SiteStore, id: string): void {
    if (import.meta.env.DEV && id === SIM_SITE_ID) {
      // Dynamic import keeps the simulator out of production bundles entirely.
      void import('$lib/dev/simulated-site').then(({ attachSimulatedSite }) => {
        // The import lands an await after it was asked for, and a sign-out in
        // that gap replaces the store. A feed for the discarded one must not
        // attach — nor overwrite the stopFeed that stops the current one.
        if (store !== site) return
        stopFeed = attachSimulatedSite(store).stop
      })
    } else {
      // The passkey prompt lands here, after the first paint — never before.
      void connect(store, id)
    }
  }

  onMount(() => {
    // The last chance to persist. 'visibilitychange' rather than 'unload',
    // which iOS does not reliably fire when an app is swiped away.
    const onHide = () => {
      if (document.visibilityState === 'hidden') void site.persistNow()
    }
    document.addEventListener('visibilitychange', onHide)
    const unlisten = router.listen()

    if (useSimulator) {
      siteId = SIM_SITE_ID
      localStorage.setItem('ftw.site', SIM_SITE_ID)
      // Only when the launch path did not already start it: a second start
      // re-reads IndexedDB on the very path that exists to touch it once.
      if (!initialSiteId) void site.start(SIM_SITE_ID)
      openFeed(site, SIM_SITE_ID)
    } else if (initialSiteId) {
      openFeed(site, initialSiteId)
    }

    return () => {
      document.removeEventListener('visibilitychange', onHide)
      unlisten()
      stopFeed?.()
      site.destroy()
    }
  })
  /**
   * What to do when no carrier could be built at all. Null while there is one.
   *
   * Every other failure on this path heals itself, because the carrier
   * reconnects from the inside. This one cannot: there is no carrier. A phone
   * whose identity was evicted while its launch pointer survived would
   * otherwise sit forever on a screen promising that it keeps trying.
   */
  let connectHelp = $state<string | null>(null)

  async function connect(store: SiteStore, id: string) {
    try {
      const { connectToSite } = await import('$lib/state/connect')
      store.connect(await connectToSite(id))
      connectHelp = null
    } catch (err) {
      // The cached readings stay on screen with an honest age. There is no
      // "try again" button because the carrier reconnects on its own — but
      // that is only true once one exists, and these are the failures where
      // none does. ConnectError already carries the sentence saying what to
      // do instead of waiting; throwing it away is what made the screen lie.
      //
      // Read for the sentence rather than for the class. An instanceof would
      // mean importing connect.ts here, on the launch path, which puts the
      // whole carrier stack in the entry chunk to answer a question about a
      // failure — and the sentence is the only part being used.
      const help = (err as { help?: unknown } | null)?.help
      connectHelp = typeof help === 'string' ? help : null
    }
  }

  function onPaired(pairedSiteId: string) {
    recovering = false
    // The decision the user just made, recorded here rather than as a side
    // effect of storing the row — see setCurrentSite.
    void import('$lib/identity/pairing').then(({ setCurrentSite }) =>
      setCurrentSite(pairedSiteId)
    )
    siteId = pairedSiteId
    // The /p#… URL just did its one job. Left in place it becomes the URL
    // the browser reloads and restores — with a spent code — which is how
    // an owner ends up on a pairing screen for a house they are standing in.
    if (location.pathname === '/p') history.replaceState(null, '', '/')
    pairingFragment = null
    void site.start(pairedSiteId)
    openFeed(site, pairedSiteId)
  }

  /**
   * The last sign-out failed and the home was put back. False otherwise.
   *
   * Held by the shell because the failure outlives the screen that met it:
   * a failed leave remounts every view against the restored store, and a
   * remounted Box has no memory of its own. The same shape as connectHelp —
   * shell state passed down, so the screen can say what happens now.
   */
  let leaveFailed = $state(false)

  /**
   * Leave this home — or put it back, if the disk would not let go of it.
   *
   * It lives in the shell because the shell owns the two things that write:
   * the session that is still receiving frames, and whatever is feeding it.
   * Both have to stop before the disk is touched, or a reading that lands
   * mid-clear writes the home straight back; leaveHome() is where that order
   * is kept and tested.
   *
   * Imported at the moment someone asks for it. A handful of installs will
   * ever run this, and none of them on the path to the first frame.
   *
   * When the disk refuses, this phone still holds the home. So the shell puts
   * it back on screen and back on the wire rather than leaving a frozen view
   * behind a message promising it still works. The views are torn down the
   * same way a successful leave tears them down — kept, they hold the stopped
   * store, untracked on purpose, and never ask the restored one for anything.
   * `leaveFailed` is how the remounted Box screen still knows what happened,
   * because its own memory of the attempt goes with it.
   */
  async function leave() {
    const id = site.siteId ?? siteId
    leaveFailed = false

    try {
      const { leaveHome } = await import('$lib/state/leave')
      await leaveHome({ home: site, stopFeed })
    } catch (err) {
      stopFeed = undefined
      // The old store is stopped for good; a fresh one restores from what is
      // still on the disk, which is the launch path with the cache warm.
      site = new SiteStore(__APP_BUILD__)
      if (id) {
        const restored = site
        void restored.start(id)
        openFeed(restored, id)
        // The pointer is cleared before the rows are, so it went even though
        // they stayed. Put it back, or the next cold start finds this home
        // the slow way — through the database, after painting nothing.
        void import('$lib/identity/pairing').then(({ setCurrentSite }) => setCurrentSite(id))
      }
      // The same reset the success path makes, for the same reason: a view
      // kept from the old store would come back holding a home that has
      // stopped. The route has not moved, so the screen being looked at is
      // rebuilt in place against the restored store.
      leaveFailed = true
      seen = { plan: false, history: false, box: false }
      throw err
    }

    // The disk holds no home now, and the copy in memory has stopped. What is
    // left is the views, still holding readings that are no longer anyone's.
    // Reloading would clear them — and reloading is never the fix in this
    // app, so the shell replaces its own state and paints the pairing screen
    // from the frame after.
    stopFeed = undefined
    site = new SiteStore(__APP_BUILD__)
    siteId = null
    // A view kept from the old store would come back holding the old home.
    seen = { plan: false, history: false, box: false }
    router.go('now')
  }
</script>

<div class="app">
  <!-- Freshness describes data from a box. With nothing paired there is no
       box and no data, so the band would be answering a question nobody
       asked — and "showing last known" would be a plain lie.

       Pointed at a home is the test, not "a reading has arrived". A phone
       that cannot reach its box has no reading and the most pressing question
       in the app: whether anything is getting through, and how old what it is
       looking at is. Hiding the band there hides the answer. -->
  <!-- Nothing about freshness while the pairing screen is up: the readings it
       would date are not on screen, and this phone is being pointed at a box
       rather than reading one. -->
  {#if hasHome && !recovering}
    <FreshnessBand
      carrier={site.carrier}
      srcState={site.srcState}
      ageMs={site.ageMs}
      phase={site.session.phase}
      noCarrier={connectHelp !== null}
    />
  {/if}

  <UpdateLine />

  <main>
    {#if resolvingSite && !pairingFragment}
      <!-- A local read, so this is a frame or two. Deliberately quiet: it is
           not a spinner for a network call, it is the app checking what it
           already knows. -->
      <section class="settling"></section>
    {:else if needsPairing || pairingFragment || recovering}
      <!-- `problem` is what this phone cannot do, and it decides which ways in
           the screen offers. Null unless a carrier could not be built at all,
           which includes the ordinary case of someone opening the floor while
           the box is merely quiet. `dismiss` exists because a screen reached
           from a home has to lead back to it. -->
      <Pair
        fragment={pairingFragment}
        problem={recovering ? connectHelp : null}
        dismiss={recovering ? () => (recovering = false) : null}
        onPaired={(s) => onPaired(s.siteId)}
      />
    {:else}
      <!-- Views are hidden, never destroyed.
           An {#if} chain tore the whole view down on every tap and built the
           next one from nothing: Plan threw away a plan it was holding and
           re-asked the box, History blanked although its tiles were on disk,
           and the scroll position went with them. That is what "going from
           live to plan feels like a page reload" was — because it was one.
           The box's own dashboard keeps every panel in the DOM and toggles a
           class, which is why it feels instant, and this now does the same.
           A view that has never been opened is still not built: `seen` gates
           the first mount, so the cost is paid once and never again. -->
      <div class="view" hidden={router.current !== 'now'}>
        <Now
          {site}
          active={router.current === 'now'}
          {connectHelp}
          wayBack={() => (recovering = true)}
        />
      </div>

      {#if seen.plan}
        <div class="view" hidden={router.current !== 'plan'}>
          <Plan {site} />
        </div>
      {/if}

      {#if seen.history}
        <!-- Loaded on demand: the chart, its canvas and the tile cache must
             not sit on the path to the first frame of the app. -->
        <div class="view" hidden={router.current !== 'history'}>
          {#await import('$views/History.svelte') then module}
            {@const History = module.default}
            <History {site} />
          {:catch}
            <!-- The chunk never arrived — an update mid-flight, a network that
                 died under it. Nothing retries a failed import; the next
                 launch fetches it fresh, and silence here reads as a broken
                 tab rather than a lost download. -->
            <p class="load-note">
              This screen didn't load — it will try again next time you open the app.
            </p>
          {/await}
        </div>
      {/if}

      {#if seen.box}
        <!-- Opened by hand a handful of times in the life of an install, so it
             is loaded when someone asks for it and never before. -->
        <div class="view" hidden={router.current !== 'box'}>
          {#await import('$views/Box.svelte') then module}
            {@const Box = module.default}
            <Box {site} {leave} stuck={leaveFailed} />
          {:catch}
            <p class="load-note">
              This screen didn't load — it will try again next time you open the app.
            </p>
          {/await}
        </div>
      {/if}
    {/if}
  </main>

  <!-- Four screens, so four buttons. The hash already works and the back
       button comes free; a router library would add a matcher and a history
       stack to decide between four names.

       Shown whenever this phone is pointed at a home, not only once a reading
       has landed. A phone that cannot reach its box and has nothing cached
       otherwise loses its whole tab bar — including the one screen that lets
       it leave, which is exactly the screen someone in that state wants.

       Not while the pairing screen is up. Those four buttons switch between
       views that are not mounted, so every one of them would do nothing; the
       way back to them is a button on that screen. -->
  {#if hasHome && !recovering}
    <nav aria-label="Views">
      <button
        type="button"
        aria-current={router.current === 'now' ? 'page' : undefined}
        onclick={() => router.go('now')}>Now</button
      >
      <button
        type="button"
        aria-current={router.current === 'plan' ? 'page' : undefined}
        onclick={() => router.go('plan')}>Plan</button
      >
      <button
        type="button"
        aria-current={router.current === 'history' ? 'page' : undefined}
        onclick={() => router.go('history')}>History</button
      >
      <button
        type="button"
        aria-current={router.current === 'box' ? 'page' : undefined}
        onclick={() => router.go('box')}>Box</button
      >
    </nav>
  {/if}

  <InstallHint />
</div>

<style>
  .settling {
    min-height: 60vh;
  }

  /* A view whose code never arrived. Quiet prose where the screen would be,
     because a blank panel under a working tab bar reads as a broken app. */
  .load-note {
    padding: var(--space-7) var(--space-4);
    color: var(--fg-muted);
    font-size: 13px;
  }

  /* `hidden` is the switch, so a view that is not showing costs no layout and
     is invisible to assistive technology — while keeping its element
     instances, its scroll position and whatever it had already loaded. */
  .view[hidden] {
    display: none;
  }

  /* The shell is exactly one screen, and the view inside it scrolls — the
     tab bar stays put and `main` scrolls inside itself.

     Anchored with `position: fixed; inset: 0`, not a height. An installed
     iOS PWA with a translucent status bar mismeasures dvh: `100dvh` came
     back short of the real screen, so the shell ended above the bottom and
     left a black band of unpainted screen under the tab bar. `inset: 0`
     pins all four edges to the actual layout viewport, which iOS reports
     correctly, so the shell fills the screen with no arithmetic to get
     wrong. The insets live here now: the top padding reserves the notch,
     the tab bar reserves the home indicator, and <body> no longer pads. */
  .app {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
    background: var(--surface);
  }

  main {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior-y: contain;
  }

  /* At the bottom because that is where a thumb is, and above the home
     indicator because that is where the phone puts its own. */
  nav {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    padding-bottom: calc(var(--space-2) + env(safe-area-inset-bottom));
    border-top: 1px solid var(--line-soft);
    background: var(--surface-sunken);
  }

  nav button {
    flex: 1;
    border-radius: var(--radius-sm);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--fg-muted);
    transition: color var(--motion-fast) var(--ease), background var(--motion-fast) var(--ease);
  }

  nav button[aria-current='page'] {
    background: var(--surface-elevated);
    color: var(--fg);
  }
</style>
