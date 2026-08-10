<!--
  App shell.

  Paints before any data arrives and never blocks on a network round trip.
  In development it attaches a simulated box so the whole client can be built
  without hardware; in production the carrier comes from enrollment.
-->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import FreshnessBand from '$lib/ui/FreshnessBand.svelte'
  import InstallHint from '$lib/ui/InstallHint.svelte'
  import UpdateLine from '$lib/ui/UpdateLine.svelte'
  import Now from '$views/Now.svelte'
  import Plan from '$views/Plan.svelte'
  import Pair from '$views/Pair.svelte'
  import { SiteStore } from '$lib/state/site.svelte'
  import { Router, type Route } from '$lib/state/route.svelte'
  import { checkForAppUpdate, serviceWorker } from '$lib/pwa/service-worker.svelte'

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
  /** A public simulator session. It has no site id and writes no home to disk. */
  let demoActive = $state(false)

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
  let restoringHome = $state(initialSiteId !== null)
  if (initialSiteId) {
    void (async () => {
      try {
        await untrack(() => site.start(initialSiteId))
      } finally {
        restoringHome = false
      }
    })()
  }

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
        if (!recovered || siteId) return
        siteId = recovered
        try {
          localStorage.setItem('ftw.site', recovered)
        } catch {
          /* the database still holds the record */
        }
        await site.start(recovered)
        await connect(site, recovered)
      } finally {
        resolvingSite = false
      }
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
  type HistoryViewComponent = (typeof import('$views/History.svelte'))['default']
  type BoxViewComponent = (typeof import('$views/Box.svelte'))['default']
  type DemoBoxViewComponent = (typeof import('$views/DemoBox.svelte'))['default']

  let HistoryView = $state<HistoryViewComponent | null>(null)
  let BoxView = $state<BoxViewComponent | null>(null)
  let DemoBoxView = $state<DemoBoxViewComponent | null>(null)
  let viewLoadError = $state({ history: false, box: false })
  let historyLoad: Promise<void> | null = null
  let boxLoad: Promise<void> | null = null

  /** The URL changes at once; the visible panel changes only when it is ready. */
  let displayedRoute = $state<Route | null>(
    router.current === 'history' || router.current === 'box' ? null : router.current
  )
  let seen = $state({
    plan: router.current === 'plan',
    history: false,
    box: false,
  })
  let routeRequest = 0
  let routeSavedFrom: Route | null = null
  const scrollByRoute: Record<Route, number> = { now: 0, plan: 0, history: 0, box: 0 }

  function loadView(route: Route): Promise<void> {
    if (route === 'history') {
      historyLoad ??= import('$views/History.svelte')
        .then((module) => {
          HistoryView = module.default
        })
        .catch(() => {
          viewLoadError.history = true
        })
      return historyLoad
    }
    if (route === 'box') {
      boxLoad ??= import('$views/Box.svelte')
        .then((module) => {
          BoxView = module.default
        })
        .catch(() => {
          viewLoadError.box = true
        })
      return boxLoad
    }
    return Promise.resolve()
  }

  function markSeen(route: Route): void {
    if (route === 'plan') seen.plan = true
    if (route === 'history') seen.history = true
    if (route === 'box') seen.box = true
  }

  /**
   * Mount a requested panel while the old one remains visible, then swap.
   *
   * The token makes a slow History import unable to win after a later Box
   * tap. The first tick mounts the target hidden; the second restores that
   * tab's own scroll position after it becomes the one layout can see.
   */
  async function showRoute(route: Route): Promise<void> {
    const request = ++routeRequest
    await loadView(route)
    if (request !== routeRequest || router.current !== route) return

    markSeen(route)
    await tick()
    if (request !== routeRequest || router.current !== route) return

    if (displayedRoute && scrollPane && routeSavedFrom !== displayedRoute) {
      scrollByRoute[displayedRoute] = scrollPane.scrollTop
    }
    routeSavedFrom = null
    displayedRoute = route
    await tick()
    if (request === routeRequest && scrollPane) scrollPane.scrollTop = scrollByRoute[route]
  }

  $effect(() => {
    const route = router.current
    void showRoute(route)
  })

  function go(route: Route): void {
    // Save before changing the hash. WebKit may reset the scroller as it
    // updates history, which is too late for the async panel swap to read it.
    if (displayedRoute && scrollPane) {
      scrollByRoute[displayedRoute] = scrollPane.scrollTop
      routeSavedFrom = displayedRoute
    }
    router.go(route)
  }

  const needsPairing = $derived(!demoActive && !siteId && !site.paired && !resolvingSite)

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
  const hasHome = $derived(demoActive || site.paired || siteId !== null)

  /** Whatever is feeding the store: the development simulator, or nothing. */
  let stopFeed: (() => void) | undefined
  /** Public demo controls, kept separate from the development debug handle. */
  let demoFeed: { tick: () => void; stop: () => void } | undefined
  /** Newest carrier build asked for per store. Older results are discarded. */
  const connectGeneration = new WeakMap<SiteStore, number>()

  /** The three DOM layers moved directly by the installed app's pull gesture. */
  let scrollPane: HTMLElement
  let pullSurface: HTMLElement
  let pullIndicator: HTMLElement

  /** Development starts on the simulator unless `?pairing` asks to review setup. */
  const preview = import.meta.env.DEV ? new URLSearchParams(location.search) : null
  const useSimulator =
    import.meta.env.DEV &&
    !preview?.has('pairing') &&
    (!initialSiteId || initialSiteId === SIM_SITE_ID)

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
      // Development loads the same on-demand simulator as the public demo.
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

  /**
   * Start the same protocol simulator used by the test suite.
   *
   * No site id is assigned and start() is not called, so the snapshot writer
   * has no key to write under. Leaving the demo destroys this store instead
   * of running the real sign-out path.
   */
  async function startDemo(): Promise<void> {
    if (demoActive) return
    const [{ attachDemoSite }, demoBox] = await Promise.all([
      import('$lib/demo/simulated-site'),
      import('$views/DemoBox.svelte'),
    ])
    const demoSite = new SiteStore(__APP_BUILD__)
    let nextDemoFeed: ReturnType<typeof attachDemoSite>
    try {
      nextDemoFeed = attachDemoSite(demoSite)
    } catch (error) {
      demoSite.destroy()
      throw error
    }

    stopFeed?.()
    site.destroy()
    site = demoSite
    demoFeed = nextDemoFeed
    DemoBoxView = demoBox.default
    stopFeed = nextDemoFeed.stop
    demoActive = true
    recovering = false
    connectHelp = null
    pairingFragment = null
    go('now')
  }

  /** Return to setup without touching any saved home or passkey. */
  function exitDemo(): void {
    if (!demoActive) return
    stopFeed?.()
    stopFeed = undefined
    demoFeed = undefined
    DemoBoxView = null
    site.destroy()
    site = new SiteStore(__APP_BUILD__)
    demoActive = false
    siteId = null
    connectHelp = null
    restoringHome = false
    resolvingSite = false
    seen = { plan: false, history: false, box: false }
    displayedRoute = 'now'
    go('now')
  }

  onMount(() => {
    // The last chance to persist. 'visibilitychange' rather than 'unload',
    // which iOS does not reliably fire when an app is swiped away.
    const onHide = () => {
      if (document.visibilityState === 'hidden') void site.persistNow()
    }
    document.addEventListener('visibilitychange', onHide)
    const unlisten = router.listen()
    const nav = navigator as Navigator & { standalone?: boolean }
    // These flags exist only in the Vite development build. They make the
    // two touch-only states renderable in a desktop browser review.
    const installed =
      nav.standalone === true ||
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      preview?.has('standalone') === true
    if (preview?.has('update-ready')) serviceWorker.waiting = true
    let mounted = true
    let stopPull: (() => void) | undefined
    let warmTimer: ReturnType<typeof setTimeout> | undefined
    const warmFrame = requestAnimationFrame(() => {
      // The launch and first real frame have gone first. These two small view
      // chunks can now parse off-screen, so the first tab tap never waits on
      // an import even when it comes from the service worker cache.
      warmTimer = setTimeout(() => {
        void Promise.all([loadView('history'), loadView('box')])
      }, 350)
    })
    // Not on the first-frame path. The gesture is installed from its cached
    // chunk just after mount, and Safari tabs keep their own native gesture.
    if (installed) {
      void import('$lib/pwa/pull-to-refresh').then(({ attachPullToRefresh }) => {
        if (!mounted) return
        stopPull = attachPullToRefresh({
          scroller: scrollPane,
          surface: pullSurface,
          indicator: pullIndicator,
          refresh: refreshCurrent,
        })
        if (preview?.has('pull-ready')) {
          const fire = (type: string, x: number, y: number) => {
            const event = new Event(type, { bubbles: true, cancelable: true })
            Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] })
            scrollPane.dispatchEvent(event)
          }
          fire('touchstart', 201, 80)
          fire('touchmove', 202, 270)
        }
      })
    }

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
      mounted = false
      cancelAnimationFrame(warmFrame)
      clearTimeout(warmTimer)
      stopPull?.()
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
    const generation = (connectGeneration.get(store) ?? 0) + 1
    connectGeneration.set(store, generation)
    const current = () =>
      connectGeneration.get(store) === generation && store === site && store.siteId === id

    try {
      const { connectToSite } = await import('$lib/state/connect')
      const carrier = await connectToSite(id)
      if (!current()) {
        carrier.close('superseded connection')
        return
      }
      if (!store.connect(carrier, id)) return
      connectHelp = null
    } catch (err) {
      // A failure from home A must not replace home B's current connection
      // state after a switch, any more than A's carrier may replace B's.
      if (!current()) return
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

  /** Check the app build and ask this home for a fresh stream in place. */
  async function refreshCurrent(): Promise<void> {
    // Update discovery is not part of the gesture's critical path. If a new
    // build finishes installing, UpdateLine appears and the user chooses the
    // one navigation that is actually needed.
    void checkForAppUpdate()

    if (demoActive) {
      demoFeed?.tick()
      return
    }

    const id = site.siteId ?? siteId
    if (!id) return

    if (import.meta.env.DEV && id === SIM_SITE_ID) {
      globalThis.ftwSim?.box.tick(1_000)
      return
    }

    await connect(site, id)
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
      displayedRoute = null
      void showRoute(router.current)
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
    displayedRoute = null
    go('now')
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
  {#if demoActive}
    <div class="demo-band" data-live={site.session.phase === 'streaming'} role="status">
      <span class="demo-dot" aria-hidden="true"></span>
      <span>{site.session.phase === 'streaming' ? 'Live demo · simulated home' : 'Starting the demo'}</span>
      <button type="button" onclick={exitDemo}>Exit demo</button>
    </div>
  {:else if hasHome && !recovering}
    <FreshnessBand
      carrier={site.carrier}
      transport={site.session.carrier}
      srcState={site.srcState}
      ageMs={site.ageMs}
      phase={site.session.phase}
      waitMs={site.connectionWaitMs}
      frameAtMs={site.lastFrameAtMs}
      bootPct={site.session.boot?.pct ?? null}
      noCarrier={connectHelp !== null}
    />
  {/if}

  <UpdateLine />

  <main bind:this={scrollPane}>
    <div class="pull-refresh" data-state="idle" aria-hidden="true" bind:this={pullIndicator}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5"></circle>
      </svg>
    </div>

    <div class="pull-surface" bind:this={pullSurface}>
    {#if (resolvingSite || restoringHome) && !pairingFragment}
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
        onTryDemo={needsPairing && !pairingFragment ? startDemo : null}
      />
    {:else}
      <!-- Views are hidden, never destroyed. A target first mounts hidden and
           only then replaces the visible panel, so a lazy chunk can never
           leave the shell with nothing to paint. Each tab also gets its own
           saved scroll position. A view that has never been requested is not
           built; `seen` pays that cost once and keeps its state after. -->
      <div class="view" hidden={displayedRoute !== 'now'}>
        <Now
          {site}
          active={displayedRoute === 'now'}
          {connectHelp}
          wayBack={() => (recovering = true)}
        />
      </div>

      {#if seen.plan}
        <div class="view" hidden={displayedRoute !== 'plan'}>
          <Plan {site} />
        </div>
      {/if}

      {#if seen.history}
        <!-- Loaded on demand: the chart, its canvas and the tile cache must
             not sit on the path to the first frame of the app. -->
        <div class="view" hidden={displayedRoute !== 'history'}>
          {#if HistoryView}
            <HistoryView {site} />
          {:else if viewLoadError.history}
            <p class="load-note">
              This screen didn't load — it will try again next time you open the app.
            </p>
          {/if}
        </div>
      {/if}

      {#if seen.box}
        <!-- Opened by hand a handful of times in the life of an install, so it
             is loaded when someone asks for it and never before. -->
        <div class="view" hidden={displayedRoute !== 'box'}>
          {#if demoActive && DemoBoxView}
            <DemoBoxView {site} onExit={exitDemo} />
          {:else if BoxView}
            <BoxView {site} {leave} stuck={leaveFailed} />
          {:else if viewLoadError.box}
            <p class="load-note">
              This screen didn't load — it will try again next time you open the app.
            </p>
          {/if}
        </div>
      {/if}
    {/if}
    </div>
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
        onclick={() => go('now')}>Now</button
      >
      <button
        type="button"
        aria-current={router.current === 'plan' ? 'page' : undefined}
        onclick={() => go('plan')}>Plan</button
      >
      <button
        type="button"
        aria-current={router.current === 'history' ? 'page' : undefined}
        onpointerdown={() => void loadView('history')}
        onclick={() => go('history')}>History</button
      >
      <button
        type="button"
        aria-current={router.current === 'box' ? 'page' : undefined}
        onpointerdown={() => void loadView('box')}
        onclick={() => go('box')}>Box</button
      >
    </nav>
  {/if}

  {#if hasHome && !recovering && !demoActive}
    <InstallHint />
  {/if}
</div>

<style>
  .demo-band {
    z-index: 5;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 36px;
    padding: 0 var(--space-4);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.05em;
    color: var(--fg-dim);
    border-bottom: 1px solid var(--line-soft);
    background: var(--surface-sunken);
  }

  .demo-dot {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: 50%;
    background: var(--fg-muted);
  }

  .demo-band[data-live='true'] .demo-dot {
    background: var(--energy-export);
  }

  .demo-band button {
    min-height: 36px;
    margin-left: auto;
    color: var(--fg-label);
    touch-action: manipulation;
  }

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

     Anchored with `position: fixed; inset: 0`, not a dynamic viewport unit.
     The insets live here: the top padding reserves the notch, the tab bar
     reserves the home indicator, and <body> only paints the backstop. */
  .app {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
    background: var(--surface);
  }

  main {
    position: relative;
    flex: 1;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    -webkit-overflow-scrolling: touch;
  }

  /* Only these two layers move during a pull. Touchmove writes their
     compositor transforms directly, so no reading or view rerenders while a
     finger is down. */
  .pull-surface {
    min-height: 100%;
    transition: transform var(--motion-base) var(--ease);
  }

  :global(.pull-surface[data-pulling='true']) {
    transition: none;
  }

  .pull-refresh {
    position: absolute;
    top: var(--space-2);
    left: 50%;
    z-index: 2;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: var(--surface-elevated);
    opacity: 0;
    pointer-events: none;
    transform: translate3d(-50%, -28px, 0) scale(0.78);
    transition:
      transform var(--motion-base) var(--ease),
      opacity var(--motion-fast) var(--ease);
    will-change: transform, opacity;
  }

  :global(.pull-refresh[data-state='pulling']),
  :global(.pull-refresh[data-state='ready']) {
    transition: none;
  }

  :global(.pull-refresh[data-state='ready']) {
    border-color: var(--accent-strong);
  }

  .pull-refresh svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: var(--fg-dim);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-dasharray: 38 16;
    transform: rotate(var(--pull-turn, 0deg));
  }

  :global(.pull-refresh[data-state='ready'] svg),
  :global(.pull-refresh[data-state='refreshing'] svg) {
    stroke: var(--accent);
  }

  :global(.pull-refresh[data-state='refreshing'] svg) {
    animation: pull-spin 620ms linear infinite;
  }

  @keyframes pull-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.pull-refresh[data-state='refreshing'] svg) {
      animation: none;
    }
  }

  /* At the bottom because that is where a thumb is, and above the home
     indicator because that is where the phone puts its own. */
  nav {
    display: flex;
    gap: var(--space-1);
    /* Pinned to the bottom of the shell whatever happens above it. `main`
       already grows to fill, so this is a belt: if anything ever stops it
       growing, the tab bar still sits on the bottom edge rather than
       floating up and leaving a band of bare shell under it. */
    margin-top: auto;
    padding: var(--space-2) var(--space-3);
    /* The home indicator's clearance, not that plus our own padding: the two
       stack into a strip of empty bar that reads as dead space on a phone.
       max() takes whichever is larger, so a device without an indicator
       keeps the ordinary padding and one with an indicator clears it
       exactly.

       The full-height standalone override paints behind the indicator, so
       this inset remains the clearance for the buttons. */
    padding-bottom: max(var(--space-2), env(safe-area-inset-bottom));
    /* The one line that says "bar". Everything else uses the app surface so
       the bar, the full-height shell and the area behind the home indicator
       read as one surface. */
    border-top: 1px solid var(--line);
    background: var(--surface);
  }

  nav button {
    flex: 1;
    border-radius: var(--radius-sm);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--fg-muted);
    touch-action: manipulation;
    transition:
      color var(--motion-fast) var(--ease),
      background var(--motion-fast) var(--ease),
      transform var(--motion-fast) var(--ease);
  }

  nav button:active {
    background: var(--surface-raised);
    transform: scale(0.97);
  }

  nav button[aria-current='page'] {
    background: var(--surface-elevated);
    color: var(--fg);
  }
</style>
