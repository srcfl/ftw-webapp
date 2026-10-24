export interface DashboardDocument {
  html: string
  nonce: string
}

export function dashboardDocument(privateView: boolean): DashboardDocument {
  const nonce = randomNonce()
  const endpoint = privateView ? '/api/admin' : '/api/public'
  const mode = privateView ? 'PRIVATE' : 'PUBLIC'
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>FTW project stats</title>
  <style nonce="${nonce}">${styles}</style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/" aria-label="FTW project stats home">
      <span class="brand-mark">FTW</span><span class="brand-slash">/</span><span>PROJECT STATS</span>
    </a>
    <div class="top-actions">
      <a href="#headline-title">GitHub</a><a href="#usage-title">Energy</a><span class="mode">${mode}</span>
      <span id="generated" class="muted">Loading</span>
    </div>
  </header>

  <main>
    <section class="hero" aria-labelledby="page-title">
      <div>
        <p class="eyebrow">OPEN SOURCE ENERGY</p>
        <h1 id="page-title">FTW development and energy.</h1>
        <p class="lede">Development across FTW Core, device drivers, Cloud, the native app, the web app and the website. Public project data, with clear sources.</p>
      </div>
      <div id="freshness" class="freshness" aria-label="Data freshness"></div>
    </section>

    <div id="notice" class="notice" hidden></div>

    <section aria-labelledby="overview-title">
      <div class="section-head">
        <div><p class="eyebrow">OVERVIEW</p><h2 id="overview-title">Project at a glance</h2></div>
        <p class="section-copy">GitHub activity, a reporting-installation estimate and group energy totals.</p>
      </div>
      <div class="overview-grid">
        <article class="metric-card overview-card"><span>Open source reach</span><strong id="overview-stars">—</strong><small id="overview-forks">— forks</small></article>
        <article class="metric-card overview-card"><span>Project work</span><strong id="overview-merges">—</strong><small id="overview-prs">Merged PRs in 30d</small></article>
        <article class="metric-card overview-card"><span>Web app visits</span><strong id="overview-visits">—</strong><small id="overview-site-note">Last 7 complete days</small></article>
        <article class="metric-card overview-card"><span id="installation-label">Active installations (estimate)</span><strong id="overview-installations">—</strong><small id="installation-period">Last 7 complete UTC days</small></article>
        <article class="metric-card overview-card"><span>Flexible power</span><strong id="usage-power">—</strong><small>Configured battery + charger limits · kW</small></article>
      </div>
    </section>

    <p id="installation-method" class="footnote">Estimate pending. Total installations through all time are unknown.</p>
    <section class="panel" aria-labelledby="usage-title">
      <div class="panel-head"><div><p class="eyebrow">ENERGY VIA FTW CLOUD</p><h2 id="usage-title">Capacity and recorded energy</h2></div><span id="usage-age" class="muted">Awaiting source</span></div>
      <div class="mini-grid usage-grid">
        <div><span>Battery capacity</span><strong id="usage-battery">—</strong><small>Configured · kWh</small></div>
        <div><span>Solar capacity</span><strong id="usage-solar">—</strong><small>Configured · kWp</small></div>
        <div><span>Solar generation</span><strong id="usage-generation">—</strong><small>Recorded hours · kWh</small></div>
        <div><span>Grid import / export</span><strong id="usage-grid">—</strong><small>Recorded hours · kWh</small></div>
        <div><span>Battery charge / discharge</span><strong id="usage-battery-energy">—</strong><small>Recorded hours · kWh</small></div>
        <div><span>Vehicle charge / discharge</span><strong id="usage-vehicle-energy">—</strong><small>Recorded hours · kWh</small></div>
      </div>
      <p id="usage-note" class="panel-copy">The Cloud usage source is not connected yet. Values appear after privacy review, policy activation and updated owner terms.</p>
      <h3 class="usage-subhead">Daily energy reports</h3>
      <div class="mini-grid usage-grid">
        <div><span>Reports</span><strong id="energy-reports">—</strong><small id="energy-day">Newest public day</small></div>
        <div><span>Solar generation</span><strong id="energy-solar">—</strong><small>Sum of reports · kWh</small></div>
        <div><span>Grid import / export</span><strong id="energy-grid">—</strong><small>Sum of reports · kWh</small></div>
        <div><span>Battery charge / discharge</span><strong id="energy-battery">—</strong><small>Sum of reports · kWh</small></div>
        <div><span>Vehicle charge</span><strong id="energy-vehicle">—</strong><small>Sum of reports · kWh</small></div>
        <div><span>Public days</span><strong id="energy-window">—</strong><small id="energy-window-note">Last 30 days</small></div>
      </div>
      <p id="energy-note" class="panel-copy">Daily energy reports appear once FTW Cloud publishes them.</p>
      <p class="footnote">Installation counts do not count people or all FTW boxes. Configured limits do not prove physical control. Hourly energy sums the recorded hours in a 24-hour window; gaps reduce coverage. Withheld cells show no value. A daily report is one box's whole UTC day, sent without any id through an independent relay, so FTW Cloud cannot tell which box sent it; a box with a gap in its day sends none. Reports are not homes.</p>
    </section>

    <section class="panel" aria-labelledby="coverage-title">
      <div class="panel-head"><div><p class="eyebrow">DATA SOURCES</p><h2 id="coverage-title">What this page covers</h2></div></div>
      <p id="coverage-repos" class="panel-copy">Six active public repositories. Private repositories and archived experiments are outside these totals.</p>
      <p class="panel-copy">The separate relay is retired. Anonymous daily reports now come through FTW Cloud. The updated Cloud terms include statistics for all Cloud users. Local FTW users can choose to contribute without remote access. Hourly collection awaits privacy review. App Store installs are not collected. Native app development appears below.</p>
      <p class="footnote">Missing usage values stay unknown. Public hourly energy cells need at least 20 contributing installations; a public day of energy reports needs at least 5 reports. Historical relay reports remain in the archive below.</p>
    </section>

    <section aria-labelledby="headline-title">
      <div class="section-head">
        <div><p class="eyebrow">DETAIL</p><h2 id="headline-title">GitHub activity</h2></div>
      </div>
      <div class="metric-grid">
        <article class="metric-card"><span>GitHub stars</span><strong id="stars">—</strong><small id="stars-change">No baseline yet</small></article>
        <article class="metric-card"><span>Forks</span><strong id="forks">—</strong><small id="forks-change">No baseline yet</small></article>
        <article class="metric-card"><span>Open PRs</span><strong id="open-prs">—</strong><small id="draft-prs">— drafts</small></article>
        <article class="metric-card"><span>Open issues</span><strong id="open-issues">—</strong><small id="closed-issues">— closed in 30d</small></article>
        <article class="metric-card"><span>Merged PRs</span><strong id="merged-prs">—</strong><small>Last 30 days</small></article>
        <article class="metric-card"><span>Repo views</span><strong id="views">—</strong><small id="visitors">14-day window</small></article>
        <article class="metric-card"><span>Clones</span><strong id="clones">—</strong><small id="cloners">14-day window</small></article>
        <article class="metric-card"><span>Contributors</span><strong id="contributors">—</strong><small>Per-repo identities, bots included</small></article>
      </div>
    </section>

    <section class="two-col" aria-label="GitHub trends">
      <article class="panel chart-panel">
        <div class="panel-head"><div><p class="eyebrow">90 DAYS</p><h2>Stars</h2></div><span id="star-range" class="muted"></span></div>
        <div id="star-chart" class="chart" role="img" aria-label="GitHub star history"></div>
      </article>
      <article class="panel chart-panel">
        <div class="panel-head"><div><p class="eyebrow">30 DAYS</p><h2>GitHub traffic</h2></div><span class="muted">Per-repo totals</span></div>
        <div id="traffic-chart" class="bars" role="img" aria-label="GitHub views by day"></div>
      </article>
    </section>

    <section class="panel" aria-labelledby="site-title">
      <div class="panel-head">
        <div><p id="site-hostname" class="eyebrow">WEB APP</p><h2 id="site-title">Server-side site traffic</h2></div>
        <span class="muted">Last 7 complete days</span>
      </div>
      <div class="mini-grid site-grid">
        <div><span>Visits</span><strong id="site-visits">—</strong></div>
        <div><span>Requests</span><strong id="site-requests">—</strong></div>
        <div><span>Data transfer</span><strong id="site-bytes">—</strong></div>
      </div>
      <div id="site-chart" class="bars compact" role="img" aria-label="FTW site visits by day"></div>
      <p id="site-note" class="footnote">A visit is an entry visit, not one user or one unique person. No browser tracker is used.</p>
    </section>

    <section class="panel" aria-labelledby="repositories-title">
      <div class="panel-head"><div><p class="eyebrow">REPOSITORIES</p><h2 id="repositories-title">Work and reach</h2></div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Repository</th><th>Stars</th><th>PRs</th><th>Issues</th><th>30d merged</th><th>Published release</th><th>Last push</th></tr></thead>
          <tbody id="repositories"></tbody>
        </table>
      </div>
      <p class="footnote">The latest published release includes beta releases. New repositories build history from their first collection.</p>
    </section>

    <section class="panel" aria-labelledby="fleet-title">
      <div class="panel-head">
        <div><p class="eyebrow">FLEET</p><h2 id="fleet-title">Archived relay reports</h2></div>
        <span id="fleet-total" class="big-inline">—</span>
      </div>
      <p id="fleet-note" class="panel-copy">A report is one daily check-in, not one user or one unique box.</p>
      <p id="fleet-source" class="footnote">Historical check-ins from the retired relay.</p>
      <div id="fleet-chart" class="bars compact" role="img" aria-label="Daily fleet reports"></div>
      <div id="fleet-dimensions" class="dimension-grid"></div>
      <p id="fleet-dimension-note" class="footnote">Versions and device integrations describe aggregate reports, not physical device counts.</p>
    </section>

    <section id="relay-section" class="panel" aria-labelledby="relay-title" hidden>
      <div class="panel-head"><div><p class="eyebrow">LEGACY RELAY · PRIVATE</p><h2 id="relay-title">Relay activity</h2></div><span id="relay-age" class="muted"></span></div>
      <div class="mini-grid">
        <div><span id="relay-rooms-label">Rooms now</span><strong id="relay-rooms">—</strong></div>
        <div><span id="relay-sockets-label">Sockets now</span><strong id="relay-sockets">—</strong></div>
        <div><span id="relay-frames-label">Frames in window</span><strong id="relay-frames">—</strong></div>
        <div><span id="relay-bytes-label">Data in window</span><strong id="relay-bytes">—</strong></div>
      </div>
      <div id="relay-chart" class="bars compact" role="img" aria-label="Relay rooms over time"></div>
      <p id="relay-note" class="footnote">Aggregate ranges only. The stats service never receives handles, addresses or routed frames.</p>
    </section>

${privateView ? opsSection : ''}    <section id="private-grid" class="two-col" hidden>
      <article class="panel">
        <div class="panel-head"><div><p class="eyebrow">DISCOVERY</p><h2>Top referrers</h2></div></div>
        <ol id="referrers" class="ranked-list"></ol>
      </article>
      <article class="panel">
        <div class="panel-head"><div><p class="eyebrow">OPERATIONS</p><h2>Collectors</h2></div></div>
        <ul id="collectors" class="status-list"></ul>
      </article>
    </section>
  </main>

  <footer>
    <span>FTW is local first. These numbers describe the project, not a household.</span>
    <a href="https://github.com/srcfl/ftw" rel="noreferrer">GitHub</a>
  </footer>

  <script nonce="${nonce}">
  'use strict';
  const endpoint = ${JSON.stringify(endpoint)};
  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat('en');

  function number(value) { return typeof value === 'number' ? fmt.format(value) : '—'; }
  function signed(value, suffix) {
    if (typeof value !== 'number') return 'No baseline yet';
    return (value > 0 ? '+' : '') + fmt.format(value) + ' ' + suffix;
  }
  function age(value) {
    if (!value) return 'not collected';
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
    if (seconds < 90) return seconds + 's ago';
    if (seconds < 5400) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 172800) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }
  function shortDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
  }
  function dayLabel(value) {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric' }).format(new Date(value));
  }
  function bytes(value) {
    if (typeof value !== 'number') return '—';
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = 0;
    while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit += 1; }
    return (size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[unit];
  }
  function setText(id, value) { $(id).textContent = value; }
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function renderFreshness(freshness, privateMode) {
    // The daily energy feed gains a day once a day, so it is stale after 48
    // hours (ENERGY_STALE_HOURS); the hourly feeds after 2.
    const labels = [['github', 'GitHub', 2], ['github_traffic', 'Repo traffic', 30], ['site', 'Web app', 2], ['cloud_fleet', 'Daily reports', 2], ['usage', 'Hourly energy', 2], ['cloud_energy', 'Daily energy', 48]];

    const host = $('freshness');
    host.replaceChildren();
    for (const [key, label, maxAgeHours] of labels) {
      const item = node('div', undefined, 'freshness-item');
      const timestamp = freshness && freshness[key];
      const dot = node('span', '', 'dot ' + (!timestamp ? 'idle' : Date.now() - Date.parse(timestamp) > maxAgeHours * 3600000 ? 'warn' : 'ok'));
      item.append(dot, node('span', label), node('strong', age(timestamp)));
      host.append(item);
    }
  }

  function renderHeadline(github) {
    const totals = github.totals || {};
    setText('stars', number(totals.stars));
    setText('stars-change', signed(totals.stars_7d, 'in 7d'));
    setText('forks', number(totals.forks));
    setText('forks-change', signed(totals.forks_30d, 'in 30d'));
    setText('open-prs', number(totals.open_prs));
    setText('draft-prs', number(totals.draft_prs) + ' drafts · ' + number(totals.dependency_prs) + ' dependency');
    setText('open-issues', number(totals.open_issues));
    setText('closed-issues', number(totals.closed_issues_30d) + ' closed in 30d');
    setText('merged-prs', number(totals.merged_prs_30d));
    setText('views', number(totals.views_14d));
    setText('visitors', number(totals.unique_visitors_14d) + ' repo-level unique');
    setText('clones', number(totals.clones_14d));
    setText('cloners', number(totals.unique_cloners_14d) + ' repo-level unique');
    setText('contributors', number(totals.contributor_identities));
  }

  function renderOverview(data) {
    const github = data.github || {};
    const totals = github.totals || {};
    const repositories = github.repositories || [];
    setText('overview-stars', number(totals.stars));
    const configured = data.coverage && data.coverage.repositories || repositories.map((repo) => repo.repo);
    const pending = data.coverage && data.coverage.pending_repositories || [];
    setText('overview-forks', number(totals.forks) + ' forks · ' + number(repositories.length) + '/' + number(configured.length) + ' repos collected');
    setText('coverage-repos', number(configured.length) + ' active public repositories: ' + configured.join(', ') + '.' +
      (pending.length ? ' Awaiting first collection: ' + pending.join(', ') + '.' : '') +
      ' Private repositories and archived experiments are outside these totals.');
    setText('overview-merges', number(totals.merged_prs_30d));
    setText('overview-prs', 'Merged PRs in 30d · ' + number(totals.open_prs) + ' open now');

    const site = data.site || {};
    const visits = site.totals && site.totals.visits_7d;
    setText('overview-visits', number(visits));
    setText('overview-site-note', typeof visits === 'number' ? 'Last 7 complete days' : 'First daily count pending');

    setText('fleet-source', 'Historical check-ins from the retired relay. Last saved summary ' + age(data.freshness && data.freshness.fleet) + '.');
  }

  function renderUsage(usage, estimate) {
    const u = usage || {};
    const format = (c, scale = 1) => c && (c.state === 'visible' || c.state === 'empty') && typeof c.value === 'number'
      ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(c.value / scale) : '—';
    const m = u.metrics || {};
    if (u.installations && u.installations.state === 'visible') {
      setText('overview-installations', format(u.installations)); setText('installation-label','Reporting installations'); setText('installation-period','Opted in · last 24 closed hours');
    } else if (estimate && typeof estimate.value === 'number') {
      setText('overview-installations','≈ ' + number(estimate.value)); setText('installation-period',estimate.window_start + ' to ' + estimate.window_end + (estimate.state === 'stale' ? ' · stale source' : ''));
    }
    if (estimate && typeof estimate.value === 'number') setText('installation-method',estimate.reports + ' reports over ' + estimate.days + ' complete days. About one successful report per installation per day. Counts reporting active installations, not people or all-time installs; opt-outs, offline boxes, failed sends, restarts and test boxes affect the estimate. Source: ' + estimate.source + '.');
    setText('usage-power', format(m.flexible_power_w, 1000));
    setText('usage-battery', format(m.battery_capacity_wh, 1000));
    setText('usage-solar', format(m.pv_rated_w, 1000));
    setText('usage-generation', format(m.pv_generation_wh, 1000));
    setText('usage-grid', format(m.grid_import_wh, 1000) + ' / ' + format(m.grid_export_wh, 1000));
    setText('usage-battery-energy', format(m.battery_charge_wh, 1000) + ' / ' + format(m.battery_discharge_wh, 1000));
    setText('usage-vehicle-energy', format(m.vehicle_charge_wh, 1000) + ' / ' + format(m.vehicle_discharge_wh, 1000));
    setText('usage-age', u.state === 'paused' ? 'Waiting for review' : age(u.observed_at));
    if (u.state === 'paused') setText('usage-note', 'Hourly energy collection is off pending privacy review and policy activation. The updated terms include statistics for all Cloud users; local users receive a separate Yes/No question. Any saved values are historical; no new household reports are collected.');
    if (u.state === 'connected') setText('usage-note', 'Window: ' + u.window_start + ' to ' + u.window_end + '. Each value needs at least 20 contributors; a household above 30% of a sum withholds that cell. ' + (Date.now() - Date.parse(u.observed_at) > 2 * 3600000 ? 'Source is stale; these are the last saved values.' : 'Source: FTW Cloud.'));
  }

  function renderEnergyReports(energy) {
    const e = energy || {};
    const kwh = (n) => typeof n === 'number' ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n) : '—';
    const d = e.latest;
    // Stale numbers stay readable but never pass for current ones.
    const stale = e.stale ? ' · stale source' : '';
    setText('energy-reports', d ? number(d.reports) : '—');
    setText('energy-day', d ? d.date + ' · UTC day' + stale : 'Newest public day');
    setText('energy-solar', kwh(d && d.pv_generation_kwh));
    setText('energy-grid', kwh(d && d.grid_import_kwh) + ' / ' + kwh(d && d.grid_export_kwh));
    setText('energy-battery', kwh(d && d.battery_charge_kwh) + ' / ' + kwh(d && d.battery_discharge_kwh));
    setText('energy-vehicle', kwh(d && d.vehicle_charge_kwh));
    const w = e.window;
    setText('energy-window', w ? number(w.days) : '—');
    const solar = w && (w.pv_generation_days === w.days ? kwh(w.pv_generation_kwh) + ' kWh solar' : kwh(w.pv_generation_kwh) + ' kWh solar on ' + number(w.pv_generation_days) + ' of them');
    setText('energy-window-note', w ? number(w.reports) + ' reports · ' + solar + stale : 'Last 30 days');
    const rule = 'A day appears once it closes for reports, four days after it ends, and needs at least ' + (e.minimum || 5) + ' reports; a sum fewer than ' + (e.minimum || 5) + ' of them had any of shows —. These are reports, not homes.';
    const source = e.stale ? ' Source is stale: last read ' + age(e.observed_at) + '. These are the last saved values.' : ' Source: FTW Cloud.';
    if (e.state === 'pending') setText('energy-note', 'Daily energy reports appear once FTW Cloud publishes them. ' + rule);
    if (e.state === 'withheld') setText('energy-note', 'No public day yet. ' + rule + source);
    if (e.state === 'connected' && d) setText('energy-note', 'Newest public day ' + d.date + '. ' + rule + source);
  }

  function renderRepositories(repositories, coverage) {
    const body = $('repositories');
    body.replaceChildren();
    const saved = new Map((repositories || []).map((repo) => [repo.repo, repo]));
    const roles = { ftw: 'Core', 'device-drivers': 'Device drivers', 'ftw-cloud': 'Cloud', 'ftw-app': 'Native app', 'ftw-webapp': 'Web app', 'ftw-web': 'Website' };
    for (const repoName of coverage && coverage.repositories || [...saved.keys()]) {
      const repo = saved.get(repoName);
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const link = node('a', repoName);
      link.href = 'https://github.com/srcfl/' + encodeURIComponent(repoName);
      link.rel = 'noreferrer';
      name.append(link);
      if (roles[repoName]) name.append(node('small', roles[repoName], 'repo-role'));
      row.append(name);
      if (!repo) {
        const pending = node('td', 'Awaiting first collection', 'muted');
        pending.colSpan = 6;
        row.append(pending);
        body.append(row);
        continue;
      }
      for (const value of [repo.stars, repo.open_prs, repo.open_issues, repo.merged_prs_30d]) {
        row.append(node('td', number(value), 'numeric'));
      }
      row.append(node('td', repo.latest_release || '—'));
      row.append(node('td', age(repo.pushed_at), 'muted'));
      body.append(row);
    }
    if (!body.children.length) {
      const row = document.createElement('tr');
      const cell = node('td', 'Waiting for the first GitHub collection.', 'empty');
      cell.colSpan = 7;
      row.append(cell);
      body.append(row);
    }
  }

  function aggregateByDate(rows, field) {
    const values = new Map();
    for (const row of rows || []) values.set(row.date, (values.get(row.date) || 0) + (row[field] || 0));
    return [...values].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
  }

  function aggregateStateHistory(rows, field, repositories) {
    const names = new Set((repositories || []).map((repo) => repo.repo));
    const byDate = new Map();
    for (const row of rows || []) {
      if (!names.has(row.repo)) continue;
      const day = byDate.get(row.date) || new Map(); day.set(row.repo, row[field]); byDate.set(row.date, day);
    }
    return [...byDate].sort((a,b) => a[0].localeCompare(b[0])).map(([date, day]) => ({ date,
      value: [...day.values()].reduce((sum,v) => sum + v, 0), cohort: [...day.keys()].sort().join(','), coverage: day.size + '/' + names.size + ' repos' }));
  }

  function renderLine(hostId, points) {
    const host = $(hostId); host.replaceChildren();
    if (!points.length) { host.append(node('p', 'A trend appears after the first saved snapshots.', 'empty')); return; }
    const width = 800, height = 210, pad = 18;
    const values = points.map(p => p.value), min = Math.min(...values), max = Math.max(...values), span = Math.max(1, max-min);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    let segment = [], cohort;
    const flush = () => { if (!segment.length) return; const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('class', 'chart-line'); line.setAttribute('points', segment.join(' ')); svg.append(line); segment = []; };
    points.forEach((p,i) => {
      const x = pad + i / Math.max(1,points.length-1) * (width-pad*2), y = height-pad-(p.value-min)/span*(height-pad*2);
      if (p.cohort !== cohort) flush(); cohort = p.cohort; segment.push(x + ',' + y);
      const dot = document.createElementNS(svg.namespaceURI, 'circle'); dot.setAttribute('cx',x); dot.setAttribute('cy',y); dot.setAttribute('r','4'); dot.setAttribute('fill','currentColor');
      const title = document.createElementNS(svg.namespaceURI,'title'); title.textContent = p.date + ': ' + number(p.value) + ' · ' + p.coverage; dot.append(title); svg.append(dot);
    }); flush(); host.append(svg);
    setText('star-range', 'Repo coverage changes break the line');
  }

  function renderBars(hostId, points, formatter) {
    const host = $(hostId);
    host.replaceChildren();
    if (!points.length) { host.append(node('p', 'No saved data yet.', 'empty')); return; }
    const max = Math.max(1, ...points.map((point) => point.value || 0));
    for (const point of points) {
      const wrap = node('div', undefined, 'bar-wrap');
      const bar = node('div', undefined, 'bar');
      const value = point.value;
      const height = value === null ? 0 : Math.max(1, Math.ceil((value / max) * 20));
      bar.classList.add('h' + height);
      bar.classList.toggle('withheld', value === null);
      wrap.title = shortDate(point.date) + ': ' + (value === null ? point.gap || 'below public threshold' : formatter(value)) + (point.coverage ? ' · ' + point.coverage : '');
      wrap.append(bar, node('span', points.length <= 16 ? dayLabel(point.date) : ''));
      host.append(wrap);
    }
  }

  function renderTraffic(rows, repositories) {
    const points = aggregateStateHistory(rows, 'views', repositories).slice(-30);
    renderBars('traffic-chart', points, number);
  }

  function renderSite(site) {
    const totals = site && site.totals || {};
    setText('site-hostname', site && site.hostname || 'WEB APP');
    setText('site-visits', number(totals.visits_7d));
    setText('site-requests', number(totals.requests_7d));
    setText('site-bytes', bytes(totals.response_bytes_7d));
    renderBars('site-chart', (site && site.days || []).map((day) => ({ date: day.date, value: day.visits })), number);
    setText(
      'site-note',
      'A visit is an entry visit, not one user or one unique person. No browser tracker is used.' +
        (site && site.sampled ? ' Cloudflare sampled at least one day, so use the counts as a trend.' : '')
    );
  }

  function addCounts(target, source) {
    for (const [label, count] of Object.entries(source || {})) target[label] = (target[label] || 0) + count;
  }
  function privateFleet(fleet) {
    const days = fleet.days || [];
    const cutoff = Date.now() - 30 * 86400000;
    const recent = days.filter((day) => Date.parse(day.date + 'T00:00:00Z') >= cutoff);
    const dimensions = {};
    for (const key of ['ftw_versions', 'channels', 'drivers', 'battery_kwh', 'price_zones', 'install_age']) {
      dimensions[key] = {};
      for (const day of recent) addCounts(dimensions[key], day[key]);
    }
    return { reports_30d: recent.reduce((sum, day) => sum + day.reports, 0), days: recent, dimensions };
  }
  function renderFleet(fleet, privateMode) {
    const view = privateMode ? privateFleet(fleet || {}) : (fleet || {});
    const note = $('fleet-note');
    if (!privateMode && view.state === 'withheld') {
      setText('fleet-total', '< ' + number(view.minimum));
      note.textContent = 'A few reports exist. Totals, versions and integration types stay hidden until ' + view.minimum + ' reports are in the 30-day window.';
    } else if (view.state === 'empty') {
      setText('fleet-total', '0');
      note.textContent = 'Waiting for the first daily report. A report is not a user or a unique box.';
    } else {
      setText('fleet-total', number(view.reports_30d) + ' / 30d');
      note.textContent = privateMode
        ? 'Private aggregate view. Reports are daily check-ins, not users or unique boxes.'
        : 'Public totals use a minimum group size of ' + view.minimum + '. A version or integration appears only when its own count reaches the same limit.';
    }
    if (!privateMode && view.state === 'withheld') {
      const chart = $('fleet-chart');
      chart.replaceChildren(node('p', 'Daily counts stay hidden while the public sample is small.', 'empty'));
    } else {
      renderBars('fleet-chart', (view.days || []).map((day) => ({ date: day.date, value: day.reports })), number);
    }
    const host = $('fleet-dimensions');
    host.replaceChildren();
    const labels = privateMode
      ? { ftw_versions: 'FTW versions', drivers: 'Device integrations', channels: 'Channels', battery_kwh: 'Battery', price_zones: 'Price zones', install_age: 'Install age' }
      : { ftw_versions: 'FTW versions', drivers: 'Device integrations' };
    for (const [key, title] of Object.entries(labels)) {
      const counts = (view.dimensions && view.dimensions[key]) || {};
      const names = privateMode
        ? Object.keys(counts)
        : [...new Set([...(view.observed && view.observed[key] || []), ...Object.keys(counts)])];
      const values = names
        .map((label) => [label, counts[label]])
        .sort((a, b) => typeof b[1] === 'number' && typeof a[1] === 'number' ? b[1] - a[1] : String(a[0]).localeCompare(String(b[0])));
      if (!values.length) continue;
      const group = node('div', undefined, 'dimension');
      group.append(node('h3', title));
      const list = node('div', undefined, 'chips');
      for (const [label, count] of values.slice(0, 12)) {
        const suffix = typeof count === 'number' ? ' · ' + number(count) : '';
        list.append(node('span', dimensionLabel(key, String(label)) + suffix, 'chip'));
      }
      group.append(list);
      host.append(group);
    }
    setText(
      'fleet-dimension-note',
      privateMode
        ? 'Driver totals count integrations present in reports, not physical devices. One report can include more than one integration.'
        : 'Each version or integration name and count stays hidden until its own count reaches the public limit. An integration type is not a physical device count.'
    );
  }

  function dimensionLabel(key, label) {
    if (key !== 'drivers') return label;
    const names = { easee_cloud: 'Easee', growatt: 'Growatt', myuplink: 'myUplink', pixii: 'Pixii', sungrow: 'Sungrow' };
    return names[label] || label.replaceAll('_', ' ');
  }

  function renderRelay(relay) {
    if (!relay) return;
    $('relay-section').hidden = false;
    if (relay.state !== 'visible' || !relay.latest) {
      setText('relay-age', 'not collected');
      renderBars('relay-chart', [], number);
      return;
    }
    setText('relay-title', 'Legacy relay load');
    setText('relay-age', age(relay.latest.observed_at));
    setText('relay-rooms', number(relay.latest.rooms));
    setText('relay-sockets', number(relay.latest.sockets));
    setText('relay-frames', number(relay.window && relay.window.frames));
    setText('relay-bytes', bytes(relay.window && relay.window.bytes));
    setText('relay-note', 'The separate relay is retired. These archived counters do not measure FTW Cloud. No handles, addresses or routed frames reach this dashboard.');
    renderBars('relay-chart', (relay.series || []).slice(-48).map((point) => ({ date: point.observed_at, value: point.rooms })), number);
  }

${privateView ? opsScript : ''}  function renderPrivate(data) {
    $('private-grid').hidden = false;
    const refs = $('referrers');
    refs.replaceChildren();
    for (const ref of (data.discovery && data.discovery.referrers || []).slice(0, 12)) {
      const item = node('li');
      item.append(node('span', ref.referrer), node('strong', number(ref.visits)));
      refs.append(item);
    }
    if (!refs.children.length) refs.append(node('li', 'No referrer data yet.', 'empty'));
    const collectors = $('collectors');
    collectors.replaceChildren();
    for (const collector of data.collectors || []) {
      const item = node('li');
      item.append(node('span', '', 'dot ' + (collector.ok ? 'ok' : 'warn')), node('strong', collector.source), node('span', age(collector.finished_at), 'muted'));
      collectors.append(item);
    }
    if (!collectors.children.length) collectors.append(node('li', 'No collector runs yet.', 'empty'));
  }

  async function load() {
    try {
      const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      setText('generated', 'Updated ' + age(data.generated_at));
      renderFreshness(data.freshness || {}, data.mode === 'private');
      renderOverview(data);
      renderUsage(data.usage, data.installation_estimate);
      renderEnergyReports(data.energy_reports);
      renderHeadline(data.github || {});
      renderRepositories(data.github && data.github.repositories, data.coverage);
      renderLine('star-chart', aggregateStateHistory(data.github && data.github.history, 'stars', data.github && data.github.repositories));
      renderTraffic(data.github && data.github.traffic, data.github && data.github.repositories);
      renderSite(data.site);
      renderFleet(data.fleet, data.mode === 'private');
      if (data.mode === 'private') renderRelay(data.relay);
      ${privateView ? "if (data.mode === 'private') renderOps(data.cloud_ops);" : ''}
      if (data.mode === 'private') renderPrivate(data);
    } catch (error) {
      const notice = $('notice');
      notice.hidden = false;
      notice.textContent = 'Stats could not load. The dashboard will try again on the next visit.';
      setText('generated', 'Unavailable');
      renderFreshness({});
    }
  }
  void load();
  </script>
</body>
</html>`
  return { html, nonce }
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const styles = `
:root{--bg:#0b0c0b;--surface:#111311;--raised:#171917;--line:#2a2d2a;--fg:#f2f1ec;--dim:#9c9f9a;--accent:#ffab2e;--accent-soft:#3b2b13;--ok:#72d69b;--warn:#ffbf5f;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg);font-synthesis:none}
[hidden]{display:none!important}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% -20%,#252116 0,transparent 34rem),var(--bg);min-height:100vh}a{color:inherit}.topbar{height:58px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 clamp(18px,4vw,56px);position:sticky;top:0;background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(16px);z-index:5}.brand{display:flex;gap:10px;align-items:center;text-decoration:none;font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em}.brand-mark{color:var(--accent)}.brand-slash{color:#5e615d}.top-actions{display:flex;align-items:center;gap:16px;font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}.mode{color:var(--accent);border:1px solid #59401c;padding:6px 8px;border-radius:2px}.muted{color:var(--dim)}main{width:min(1280px,calc(100% - 36px));margin:0 auto;padding:64px 0 72px}.hero{display:flex;justify-content:space-between;gap:48px;align-items:flex-end;margin-bottom:54px}.eyebrow{color:var(--accent);font:700 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;margin:0 0 12px}h1{font-size:clamp(36px,5vw,72px);line-height:.98;letter-spacing:-.055em;max-width:800px;margin:0}h2{font-size:20px;letter-spacing:-.025em;margin:0}h3{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:0 0 10px}.lede{color:var(--dim);font-size:17px;max-width:660px;line-height:1.5;margin:20px 0 0}.freshness{min-width:230px;display:grid;gap:8px}.freshness-item{display:grid;grid-template-columns:10px 1fr auto;align-items:center;gap:10px;font-size:12px;color:var(--dim)}.freshness-item strong{font-weight:500;color:var(--fg)}.dot{width:7px;height:7px;border-radius:50%;background:#555;display:inline-block}.dot.ok{background:var(--ok);box-shadow:0 0 12px color-mix(in srgb,var(--ok) 50%,transparent)}.dot.warn{background:var(--warn)}.dot.idle{background:#555}.notice{border:1px solid #674a20;background:#21190e;color:#ffd48f;padding:14px 16px;margin-bottom:24px}.section-head,.panel-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px}.section-head{margin:0 0 16px}.section-copy{color:var(--dim);font-size:12px;line-height:1.5;max-width:560px;margin:0;text-align:right}.overview-grid,.metric-grid{display:grid;border-top:1px solid var(--line);border-left:1px solid var(--line);margin-bottom:28px}.overview-grid{grid-template-columns:repeat(5,minmax(0,1fr))}.metric-grid{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:18px}.metric-card{background:color-mix(in srgb,var(--surface) 92%,transparent);min-height:154px;padding:22px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;flex-direction:column}.overview-card{min-height:142px}.metric-card>span,.mini-grid span{font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}.metric-card strong{font-size:42px;line-height:1;margin:auto 0 12px;letter-spacing:-.05em}.metric-card.status-card strong{font-size:30px;letter-spacing:-.035em}.metric-card small{color:var(--dim);font-size:12px;line-height:1.35}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:18px 0}.panel{background:color-mix(in srgb,var(--surface) 94%,transparent);border:1px solid var(--line);padding:22px;margin:18px 0}.two-col>.panel{margin:0}.chart-panel{min-height:330px}.chart{height:235px;margin-top:24px}.chart svg{display:block;width:100%;height:100%;overflow:visible}h2{scroll-margin-top:90px}.mini-grid.usage-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.chart-panel .muted{font-size:11px}.chart-area{fill:color-mix(in srgb,var(--accent) 9%,transparent)}.chart-line{fill:none;stroke:var(--accent);stroke-width:3;stroke-linejoin:round;stroke-linecap:round}.bars{height:230px;display:flex;gap:4px;align-items:flex-end;margin-top:24px;border-bottom:1px solid var(--line);padding:0 2px}.bars.compact{height:150px}.bar-wrap{height:100%;flex:1;min-width:3px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:8px}.bar{width:100%;max-width:28px;background:linear-gradient(to top,#88520d,var(--accent));border-radius:2px 2px 0 0;min-height:2px}.bar.withheld{background:#4a4c49}.bar.h0{height:2%}.bar.h1{height:5%}.bar.h2{height:10%}.bar.h3{height:15%}.bar.h4{height:20%}.bar.h5{height:25%}.bar.h6{height:30%}.bar.h7{height:35%}.bar.h8{height:40%}.bar.h9{height:45%}.bar.h10{height:50%}.bar.h11{height:55%}.bar.h12{height:60%}.bar.h13{height:65%}.bar.h14{height:70%}.bar.h15{height:75%}.bar.h16{height:80%}.bar.h17{height:85%}.bar.h18{height:90%}.bar.h19{height:95%}.bar.h20{height:100%}.bar-wrap span{font-size:8px;color:var(--dim);height:12px;white-space:nowrap}.table-wrap{overflow-x:auto;margin-top:20px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--dim);font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;padding:12px 14px;border-bottom:1px solid var(--line)}td{padding:15px 14px;border-bottom:1px solid #232523;white-space:nowrap}td:first-child{font-weight:650}td a{text-decoration-color:#51544f;text-underline-offset:3px}.repo-role{display:block;color:var(--dim);font-size:11px;font-weight:400;margin-top:4px}.numeric{font-variant-numeric:tabular-nums}.empty{color:var(--dim);padding:30px 4px;text-align:center}.panel-copy,.footnote{color:var(--dim);font-size:13px;line-height:1.5}.big-inline{font-size:28px;font-weight:700;letter-spacing:-.04em}.dimension-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:26px}.dimension{border-top:1px solid var(--line);padding-top:14px}.chips{display:flex;gap:7px;flex-wrap:wrap}.chip{font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d5d3cb;background:var(--raised);border:1px solid var(--line);padding:6px 8px;border-radius:2px}.mini-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);margin-top:22px}.mini-grid>div{background:var(--raised);padding:18px;display:flex;flex-direction:column;gap:12px}.mini-grid strong{font-size:26px}.ranked-list,.status-list{list-style:none;padding:0;margin:18px 0 0}.ranked-list li{display:flex;justify-content:space-between;gap:18px;padding:12px 0;border-bottom:1px solid var(--line);font-size:13px}.status-list li{display:grid;grid-template-columns:10px 1fr auto;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--line);font-size:12px}footer{border-top:1px solid var(--line);padding:24px clamp(18px,4vw,56px);display:flex;justify-content:space-between;gap:20px;color:var(--dim);font-size:12px}footer a{color:var(--fg);text-underline-offset:3px}
.mini-grid.site-grid{grid-template-columns:repeat(3,1fr)}
.usage-subhead{margin:28px 0 0}
@media(max-width:1100px){.overview-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:900px){.hero{align-items:flex-start;flex-direction:column}.freshness{width:100%;grid-template-columns:repeat(2,1fr)}.section-head{align-items:flex-start;flex-direction:column}.section-copy{text-align:left}.overview-grid,.metric-grid{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}.dimension-grid{grid-template-columns:repeat(2,1fr)}.mini-grid,.mini-grid.usage-grid{grid-template-columns:repeat(2,1fr)}.mini-grid.site-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:560px){main{width:min(100% - 24px,1280px);padding-top:38px}.topbar{padding:0 12px}.top-actions #generated{display:none}.hero{margin-bottom:36px;gap:28px}h1{font-size:40px}.freshness{grid-template-columns:1fr}.metric-card{min-height:130px;padding:16px}.metric-card strong{font-size:34px}.panel{padding:16px}.dimension-grid{grid-template-columns:1fr}.mini-grid{grid-template-columns:1fr 1fr}.bars{gap:2px}footer{flex-direction:column;padding:20px 12px}}
@media(max-width:560px){.mini-grid.site-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`

// The private view's Service operations panel and its script. The public
// page carries neither: its markup, copy and code stay as they were.
const opsSection = `    <section id="ops-section" class="panel" aria-labelledby="ops-title" hidden>
      <div class="panel-head"><div><p class="eyebrow">FTW CLOUD · PRIVATE</p><h2 id="ops-title">Service operations</h2></div><span id="ops-age" class="muted">not collected</span></div>
      <p class="panel-copy">Each hour sums over the whole service. No home, device or address reaches this page. Cloud and this page keep the hours for 90 days.</p>
      <div class="mini-grid">
        <div><span>Boxes connected</span><strong id="ops-boxes">—</strong><small id="ops-boxes-note" class="muted"></small></div>
        <div><span>Phones connected</span><strong id="ops-phones">—</strong><small id="ops-phones-note" class="muted"></small></div>
        <div><span>Over QUIC</span><strong id="ops-quic">—</strong><small id="ops-quic-note" class="muted">boxes, last hour</small></div>
        <div><span>Data out this month</span><strong id="ops-bytes">—</strong><small id="ops-budget" class="muted">of 100 GB free</small></div>
      </div>
      <div id="ops-chart" class="bars compact" role="img" aria-label="Most boxes connected each hour, last 48 hours"></div>
      <div class="dimension-grid">
        <div class="dimension"><h3>Drops, 7 days</h3><ul id="ops-drops" class="ranked-list"></ul></div>
        <div class="dimension"><h3>Push, 7 days</h3><ul id="ops-push" class="ranked-list"></ul></div>
        <div class="dimension"><h3>Assistant calls, 7 days</h3><ul id="ops-mcp" class="ranked-list"></ul></div>
        <div class="dimension"><h3>Slowest p99, 24 hours</h3><ul id="ops-latency" class="ranked-list"></ul></div>
        <div class="dimension"><h3>Deploys and drains, 30 days</h3><ul id="ops-deploys" class="ranked-list"></ul></div>
        <div class="dimension"><h3>Daily reports, exact</h3><ul id="ops-fleet" class="ranked-list"></ul></div>
      </div>
      <p id="ops-fleet-note" class="footnote">Exact daily reports for closed UTC days, below the public group size of 5 too. A report is a daily check-in, not a user or a unique box. Health counts come only from reports that carry them: the slowest plan and fallback plans of the box's last day, the share of failed driver reads, and the newest update of its last week.</p>
      <div id="ops-fleet-labels" class="dimension-grid"></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Energy reports, exact</th><th class="numeric">Reports</th><th class="numeric">Solar kWh</th><th class="numeric">Import / export kWh</th><th class="numeric">Battery in / out kWh</th><th class="numeric">Vehicle kWh</th></tr></thead>
          <tbody id="ops-energy"></tbody>
        </table>
      </div>
      <p class="footnote">A date shows once no report may name it, four days after it ends. Each report is one box's whole UTC day, sent without an id through an independent relay. Reports are not homes.</p>
    </section>

`

const opsScript = `  function listInto(id, rows, empty) {
    const host = $(id);
    host.replaceChildren();
    for (const [label, value] of rows) {
      const item = node('li');
      item.append(node('span', label), node('strong', value));
      host.append(item);
    }
    if (!host.children.length) host.append(node('li', empty, 'empty'));
  }
  function ms(value) {
    if (value === 'over_10s') return 'over 10 s';
    return typeof value === 'number' ? (value < 10 ? value.toFixed(2) : fmt.format(value)) + ' ms' : '—';
  }
  function renderOps(ops) {
    if (!ops) return;
    $('ops-section').hidden = false;
    const fleet = ops.fleet || { days: [] };
    const days = (fleet.days || []).slice(-14).reverse();
    listInto('ops-fleet', days.map((day) => [day.date, number(day.reports)]), 'No daily reports yet.');
    if (fleet.state === 'stale') setText('ops-fleet-note', 'Source is stale: the last saved daily totals came ' + age(fleet.observed_at) + '. These are the last saved values.');
    const labels = $('ops-fleet-labels');
    labels.replaceChildren();
    const titles = { ftw_versions: 'FTW versions', drivers: 'Device integrations', channels: 'Channels', battery_kwh: 'Battery', price_zones: 'Price zones', install_age: 'Install age',
      plan_solve: 'Slowest plan', plan_fallbacks: 'Fallback plans', driver_errors: 'Failed driver reads', update: 'Newest update' };
    if (days[0]) {
      for (const key of Object.keys(titles).filter((k) => days[0][k])) {
        const block = node('div', undefined, 'dimension');
        block.append(node('h3', titles[key] + ', ' + shortDate(days[0].date)));
        const chips = node('div', undefined, 'chips');
        for (const [label, count] of Object.entries(days[0][key] || {}).sort((a, b) => b[1] - a[1])) chips.append(node('span', dimensionLabel(key, label) + ' · ' + number(count), 'chip'));
        block.append(chips);
        labels.append(block);
      }
    }
    const energy = $('ops-energy');
    energy.replaceChildren();
    for (const day of ((ops.energy && ops.energy.days) || []).slice(-14).reverse()) {
      const row = node('tr');
      row.append(node('td', day.date));
      for (const value of [number(day.reports), number(day.pv_generation_kwh), number(day.grid_import_kwh) + ' / ' + number(day.grid_export_kwh),
        number(day.battery_charge_kwh) + ' / ' + number(day.battery_discharge_kwh), number(day.vehicle_charge_kwh)]) row.append(node('td', value, 'numeric'));
      energy.append(row);
    }
    if (!energy.children.length) {
      const row = node('tr');
      const cell = node('td', 'No closed energy dates yet.', 'empty');
      cell.colSpan = 6;
      row.append(cell);
      energy.append(row);
    }
    if (ops.state === 'empty') {
      setText('ops-age', 'not collected');
      renderBars('ops-chart', [], number);
      for (const id of ['ops-drops', 'ops-push', 'ops-mcp', 'ops-latency', 'ops-deploys']) listInto(id, [], 'No service hours yet.');
      return;
    }
    setText('ops-age', (ops.state === 'stale' ? 'stale · ' : '') + 'hour of ' + new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ops.latest_hour)));
    const now = ops.now || {};
    setText('ops-boxes', now.boxes ? number(now.boxes.max) : '—');
    setText('ops-boxes-note', now.boxes ? 'mean ' + number(now.boxes.mean) + ', low ' + number(now.boxes.min) + ' in the hour' : '');
    setText('ops-phones', now.phones ? number(now.phones.max) : '—');
    setText('ops-phones-note', now.phones ? 'mean ' + number(now.phones.mean) + ' in the hour' : '');
    setText('ops-quic', typeof now.box_quic_percent === 'number' ? now.box_quic_percent + ' %' : '—');
    setText('ops-quic-note', 'boxes; phones ' + (typeof now.app_quic_percent === 'number' ? now.app_quic_percent + ' %' : '—'));
    const month = ops.month || {};
    setText('ops-bytes', bytes(month.bytes_out));
    setText('ops-budget', (typeof month.budget_percent === 'number' ? month.budget_percent + ' % ' : '') + 'of ' + bytes(month.budget_bytes) + ' free; tunnel ' + bytes(month.tun_bytes) +
      '; ' + number(month.hours_recorded) + ' of ' + number(month.hours_so_far) + ' hours recorded');
    renderBars('ops-chart', (ops.hours || []).map((h) => ({ date: h.hour, value: h.missing ? null : h.boxes_max,
      gap: 'no hour from Cloud', coverage: new Date(h.hour).toISOString().slice(11, 16) + ' UTC' + (h.starts ? ' · restart in the hour' : '') })), number);
    const week = ops.week || {};
    // A week without hours is a week without data, not a quiet week.
    const quiet = (text) => week.hours_recorded ? text : 'No service hours in the last 7 days.';
    listInto('ops-drops', (week.drops || []).slice(0, 10).map((d) => [d.name.replace(/_/g, ' '), number(d.count)]), quiet('Nothing dropped.'));
    const push = week.push || {};
    listInto('ops-push', [['Alerts', push.alert], ['Widgets', push.widgets], ['Browsers', push.browser]].filter((r) => r[1] && r[1].sent)
      .map(([label, r]) => [label + ' · ' + number(r.sent), r.ok_percent + ' % ok']).concat(push.breaker_opened ? [['Breaker opened', number(push.breaker_opened)]] : []), quiet('No pushes sent.'));
    listInto('ops-mcp', ((week.mcp && week.mcp.outcomes) || []).map((o) => [o.name.replace(/_/g, ' '), number(o.count)])
      .concat(week.mcp && week.mcp.p99_ms_max !== null && week.mcp.p99_ms_max !== undefined ? [['slowest hour p99', ms(week.mcp.p99_ms_max)]] : []), quiet('No assistant calls.'));
    listInto('ops-latency', (ops.latency_24h || []).filter((l) => l.n > 0).map((l) => [l.name.replace(/_seconds/, '').replace(/_/g, ' ') + ' · ' + number(l.n), ms(l.p99_ms_max)]), 'Nothing timed.');
    listInto('ops-deploys', (ops.deploys || []).slice(0, 8).map((d) => [shortDate(d.hour) + ' ' + new Date(d.hour).toISOString().slice(11, 16) + ' UTC',
      (d.starts ? number(d.starts) + ' start' : 'no start') + ' · ' + number(d.drained_sockets) + ' drained' + (d.left_open ? ', ' + number(d.left_open) + ' left open' : '') + ' · ' + number(d.box_handshakes) + ' box handshakes']), 'No deploys in 30 days.');
  }

`
