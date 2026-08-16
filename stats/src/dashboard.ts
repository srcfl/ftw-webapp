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
      <span class="mode">${mode}</span>
      <span id="generated" class="muted">Loading</span>
    </div>
  </header>

  <main>
    <section class="hero" aria-labelledby="page-title">
      <div>
        <p class="eyebrow">OPEN SOURCE ENERGY</p>
        <h1 id="page-title">Project growth, without user tracking.</h1>
        <p class="lede">GitHub reach, site visits, project work, relay reporting and anonymous fleet reports in one place.</p>
      </div>
      <div id="freshness" class="freshness" aria-label="Data freshness"></div>
    </section>

    <div id="notice" class="notice" hidden></div>

    <section aria-labelledby="overview-title">
      <div class="section-head">
        <div><p class="eyebrow">OVERVIEW</p><h2 id="overview-title">Project at a glance</h2></div>
        <p class="section-copy">Public figures are broad aggregates. Small fleet counts stay private; relay activity is shown only as ranges.</p>
      </div>
      <div class="overview-grid">
        <article class="metric-card overview-card"><span>Open source reach</span><strong id="overview-stars">—</strong><small id="overview-forks">— forks</small></article>
        <article class="metric-card overview-card"><span>Project work</span><strong id="overview-merges">—</strong><small id="overview-prs">Merged PRs in 30d</small></article>
        <article class="metric-card overview-card"><span>Site visits</span><strong id="overview-visits">—</strong><small id="overview-site-note">Last 14 complete days</small></article>
        <article class="metric-card overview-card"><span>Fleet</span><strong id="overview-fleet">—</strong><small id="overview-fleet-note">Daily reports in 30d</small></article>
        <article class="metric-card overview-card status-card"><span>Relay activity</span><strong id="overview-relay">—</strong><small id="overview-relay-note">Aggregate ranges only</small></article>
      </div>
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
        <div><p class="eyebrow">FTW.ENERGY</p><h2 id="site-title">Server-side site traffic</h2></div>
        <span class="muted">Last 14 complete days</span>
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
          <thead><tr><th>Repository</th><th>Stars</th><th>PRs</th><th>Issues</th><th>30d merged</th><th>Latest release</th><th>Updated</th></tr></thead>
          <tbody id="repositories"></tbody>
        </table>
      </div>
    </section>

    <section class="panel" aria-labelledby="fleet-title">
      <div class="panel-head">
        <div><p class="eyebrow">FLEET</p><h2 id="fleet-title">Anonymous daily reports</h2></div>
        <span id="fleet-total" class="big-inline">—</span>
      </div>
      <p id="fleet-note" class="panel-copy">A report is one daily check-in, not one user or one unique box.</p>
      <div id="fleet-chart" class="bars compact" role="img" aria-label="Daily fleet reports"></div>
      <div id="fleet-dimensions" class="dimension-grid"></div>
      <p id="fleet-dimension-note" class="footnote">Versions and device integrations describe aggregate reports, not physical device counts.</p>
    </section>

    <section id="relay-section" class="panel" aria-labelledby="relay-title" hidden>
      <div class="panel-head"><div><p class="eyebrow">RELAY</p><h2 id="relay-title">Relay activity</h2></div><span id="relay-age" class="muted"></span></div>
      <div class="mini-grid">
        <div><span id="relay-rooms-label">Rooms now</span><strong id="relay-rooms">—</strong></div>
        <div><span id="relay-sockets-label">Sockets now</span><strong id="relay-sockets">—</strong></div>
        <div><span id="relay-frames-label">Frames in window</span><strong id="relay-frames">—</strong></div>
        <div><span id="relay-bytes-label">Data in window</span><strong id="relay-bytes">—</strong></div>
      </div>
      <div id="relay-chart" class="bars compact" role="img" aria-label="Relay rooms over time"></div>
      <p id="relay-note" class="footnote">Aggregate ranges only. The stats service never receives handles, addresses or routed frames.</p>
    </section>

    <section id="private-grid" class="two-col" hidden>
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

  function renderFreshness(freshness) {
    const labels = [['github', 'GitHub'], ['github_traffic', 'Repo traffic'], ['site', 'Site'], ['fleet', 'Fleet'], ['relay', 'Relay']];
    const host = $('freshness');
    host.replaceChildren();
    for (const [key, label] of labels) {
      const item = node('div', undefined, 'freshness-item');
      const timestamp = freshness && freshness[key];
      const dot = node('span', '', 'dot ' + (!timestamp ? 'idle' : Date.now() - Date.parse(timestamp) > 2 * 3600000 ? 'warn' : 'ok'));
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
    setText('overview-forks', number(totals.forks) + ' forks across ' + number(repositories.length) + ' repos');
    setText('overview-merges', number(totals.merged_prs_30d));
    setText('overview-prs', 'Merged PRs in 30d · ' + number(totals.open_prs) + ' open now');

    const site = data.site || {};
    const visits = site.totals && site.totals.visits_14d;
    setText('overview-visits', number(visits));
    setText('overview-site-note', typeof visits === 'number' ? 'Last 14 complete days' : 'First daily count pending');

    const fleet = data.mode === 'private' ? privateFleet(data.fleet || {}) : (data.fleet || {});
    const observed = fleet.observed || {};
    const versions = observed.ftw_versions || [];
    const integrations = observed.drivers || [];
    const fleetSignal = versions.length || integrations.length
      ? (versions.length === 1 ? versions[0] : number(versions.length) + ' versions') +
        ' · ' + number(integrations.length) + ' integration type' + (integrations.length === 1 ? '' : 's')
      : null;
    if (data.mode !== 'private' && fleet.state === 'withheld') {
      setText('overview-fleet', '< ' + number(fleet.minimum));
      setText('overview-fleet-note', fleetSignal || 'Reports in 30d · exact count private');
    } else if (fleet.state === 'empty') {
      setText('overview-fleet', '0');
      setText('overview-fleet-note', 'No daily reports yet');
    } else {
      setText('overview-fleet', number(fleet.reports_30d));
      setText('overview-fleet-note', fleetSignal || 'Daily reports in 30d · not unique boxes');
    }

    const relay = data.relay_activity || data.relay_status || {};
    if (relay.state === 'reporting' && relay.rooms_band) {
      setText('overview-relay', relay.rooms_band + ' rooms');
      setText('overview-relay-note', relay.frames_band + ' frames in window · ' + age(relay.observed_at));
    } else {
      const relayLabel = relay.state === 'delayed' ? 'Delayed' : 'Waiting';
      setText('overview-relay', relayLabel);
      setText(
        'overview-relay-note',
        relay.observed_at ? 'Last aggregate ' + age(relay.observed_at) : 'First aggregate pending'
      );
    }
  }

  function renderRepositories(repositories) {
    const body = $('repositories');
    body.replaceChildren();
    for (const repo of repositories || []) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const link = node('a', repo.repo);
      link.href = 'https://github.com/srcfl/' + encodeURIComponent(repo.repo);
      link.rel = 'noreferrer';
      name.append(link);
      row.append(name);
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
    const dates = [...new Set((rows || []).map((row) => row.date))].sort();
    const current = new Map();
    const points = [];
    for (const date of dates) {
      for (const row of (rows || []).filter((item) => item.date === date)) current.set(row.repo, row[field]);
      if ([...names].every((name) => current.has(name))) {
        points.push({ date, value: [...names].reduce((sum, name) => sum + current.get(name), 0) });
      }
    }
    return points;
  }

  function aggregateCompleteDays(rows, field, repositories) {
    const names = new Set((repositories || []).map((repo) => repo.repo));
    const byDate = new Map();
    for (const row of rows || []) {
      const day = byDate.get(row.date) || { repos: new Set(), value: 0 };
      day.repos.add(row.repo);
      day.value += row[field] || 0;
      byDate.set(row.date, day);
    }
    return [...byDate]
      .filter(([, day]) => [...names].every((name) => day.repos.has(name)))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, day]) => ({ date, value: day.value }));
  }

  function renderLine(hostId, points) {
    const host = $(hostId);
    host.replaceChildren();
    if (!points.length) { host.append(node('p', 'A trend appears after the first saved snapshots.', 'empty')); return; }
    const width = 800, height = 210, pad = 18;
    const values = points.map((point) => point.value);
    const min = Math.min(...values), max = Math.max(...values);
    const span = Math.max(1, max - min);
    const coords = points.map((point, index) => {
      const x = pad + (index / Math.max(1, points.length - 1)) * (width - pad * 2);
      const y = height - pad - ((point.value - min) / span) * (height - pad * 2);
      return [x, y];
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('aria-hidden', 'true');
    const area = document.createElementNS(svg.namespaceURI, 'path');
    const line = document.createElementNS(svg.namespaceURI, 'polyline');
    const linePoints = coords.map((point) => point.join(',')).join(' ');
    area.setAttribute('d', 'M ' + coords[0][0] + ' ' + (height - pad) + ' L ' + linePoints.replaceAll(' ', ' L ') + ' L ' + coords.at(-1)[0] + ' ' + (height - pad) + ' Z');
    area.setAttribute('class', 'chart-area');
    line.setAttribute('points', linePoints);
    line.setAttribute('class', 'chart-line');
    svg.append(area, line);
    host.append(svg);
    setText('star-range', number(min) + ' → ' + number(max));
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
      wrap.title = shortDate(point.date) + ': ' + (value === null ? 'below public threshold' : formatter(value));
      wrap.append(bar, node('span', points.length <= 16 ? dayLabel(point.date) : ''));
      host.append(wrap);
    }
  }

  function renderTraffic(rows, repositories) {
    const points = aggregateCompleteDays(rows, 'views', repositories).slice(-30);
    renderBars('traffic-chart', points, number);
  }

  function renderSite(site) {
    const totals = site && site.totals || {};
    setText('site-visits', number(totals.visits_14d));
    setText('site-requests', number(totals.requests_14d));
    setText('site-bytes', bytes(totals.response_bytes_14d));
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
      note.textContent = 'A few reports exist. Versions and integration types appear below, but counts stay hidden until ' + view.minimum + ' reports are in the 30-day window.';
    } else if (view.state === 'empty') {
      setText('fleet-total', '0');
      note.textContent = 'Waiting for the first daily report. A report is not a user or a unique box.';
    } else {
      setText('fleet-total', number(view.reports_30d) + ' / 30d');
      note.textContent = privateMode
        ? 'Private aggregate view. Reports are daily check-ins, not users or unique boxes.'
        : 'Public counts use a minimum group size of ' + view.minimum + '. Version and integration names may appear without counts.';
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
        : 'Names show what appeared in aggregate reports. Counts below the public limit stay hidden. An integration type is not a physical device count.'
    );
  }

  function dimensionLabel(key, label) {
    if (key !== 'drivers') return label;
    const names = { easee_cloud: 'Easee', growatt: 'Growatt', myuplink: 'myUplink', pixii: 'Pixii', sungrow: 'Sungrow' };
    return names[label] || label.replaceAll('_', ' ');
  }

  function renderRelay(relay, privateMode) {
    if (!relay) return;
    $('relay-section').hidden = false;
    const chart = $('relay-chart');
    chart.hidden = !privateMode;
    if ((privateMode && (relay.state !== 'visible' || !relay.latest)) || (!privateMode && relay.state === 'empty')) {
      setText('relay-age', 'not collected');
      if (privateMode) renderBars('relay-chart', [], number);
      return;
    }
    if (privateMode) {
      setText('relay-title', 'Blind relay load');
      setText('relay-age', age(relay.latest.observed_at));
      setText('relay-rooms', number(relay.latest.rooms));
      setText('relay-sockets', number(relay.latest.sockets));
      setText('relay-frames', number(relay.window && relay.window.frames));
      setText('relay-bytes', bytes(relay.window && relay.window.bytes));
      setText('relay-note', 'Counts only. The stats service never receives handles, addresses or routed frames.');
      renderBars('relay-chart', (relay.series || []).slice(-48).map((point) => ({ date: point.observed_at, value: point.rooms })), number);
      return;
    }
    setText('relay-title', 'Aggregate relay activity');
    setText('relay-age', relay.state === 'delayed' ? 'delayed · ' + age(relay.observed_at) : age(relay.observed_at));
    setText('relay-rooms', relay.rooms_band || '—');
    setText('relay-sockets', relay.sockets_band || '—');
    setText('relay-frames', relay.frames_band || '—');
    setText('relay-bytes', relay.bytes_band || '—');
    setText('relay-note', 'Coarse ranges cover the current relay process, up to the last 24 hours. They are activity bands, not user or household counts.');
  }

  function renderPrivate(data) {
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
      renderFreshness(data.freshness || {});
      renderOverview(data);
      renderHeadline(data.github || {});
      renderRepositories(data.github && data.github.repositories);
      renderLine('star-chart', aggregateStateHistory(data.github && data.github.history, 'stars', data.github && data.github.repositories));
      renderTraffic(data.github && data.github.traffic, data.github && data.github.repositories);
      renderSite(data.site);
      renderFleet(data.fleet, data.mode === 'private');
      renderRelay(data.mode === 'private' ? data.relay : data.relay_activity, data.mode === 'private');
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
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% -20%,#252116 0,transparent 34rem),var(--bg);min-height:100vh}a{color:inherit}.topbar{height:58px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 clamp(18px,4vw,56px);position:sticky;top:0;background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(16px);z-index:5}.brand{display:flex;gap:10px;align-items:center;text-decoration:none;font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em}.brand-mark{color:var(--accent)}.brand-slash{color:#5e615d}.top-actions{display:flex;align-items:center;gap:16px;font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}.mode{color:var(--accent);border:1px solid #59401c;padding:6px 8px;border-radius:2px}.muted{color:var(--dim)}main{width:min(1280px,calc(100% - 36px));margin:0 auto;padding:64px 0 72px}.hero{display:flex;justify-content:space-between;gap:48px;align-items:flex-end;margin-bottom:54px}.eyebrow{color:var(--accent);font:700 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;margin:0 0 12px}h1{font-size:clamp(36px,5vw,72px);line-height:.98;letter-spacing:-.055em;max-width:800px;margin:0}h2{font-size:20px;letter-spacing:-.025em;margin:0}h3{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:0 0 10px}.lede{color:var(--dim);font-size:17px;max-width:660px;line-height:1.5;margin:20px 0 0}.freshness{min-width:230px;display:grid;gap:8px}.freshness-item{display:grid;grid-template-columns:10px 1fr auto;align-items:center;gap:10px;font-size:12px;color:var(--dim)}.freshness-item strong{font-weight:500;color:var(--fg)}.dot{width:7px;height:7px;border-radius:50%;background:#555;display:inline-block}.dot.ok{background:var(--ok);box-shadow:0 0 12px color-mix(in srgb,var(--ok) 50%,transparent)}.dot.warn{background:var(--warn)}.dot.idle{background:#555}.notice{border:1px solid #674a20;background:#21190e;color:#ffd48f;padding:14px 16px;margin-bottom:24px}.section-head,.panel-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px}.section-head{margin:0 0 16px}.section-copy{color:var(--dim);font-size:12px;line-height:1.5;max-width:560px;margin:0;text-align:right}.overview-grid,.metric-grid{display:grid;border-top:1px solid var(--line);border-left:1px solid var(--line);margin-bottom:28px}.overview-grid{grid-template-columns:repeat(5,minmax(0,1fr))}.metric-grid{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:18px}.metric-card{background:color-mix(in srgb,var(--surface) 92%,transparent);min-height:154px;padding:22px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;flex-direction:column}.overview-card{min-height:142px}.metric-card>span,.mini-grid span{font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}.metric-card strong{font-size:42px;line-height:1;margin:auto 0 12px;letter-spacing:-.05em}.metric-card.status-card strong{font-size:30px;letter-spacing:-.035em}.metric-card small{color:var(--dim);font-size:12px;line-height:1.35}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:18px 0}.panel{background:color-mix(in srgb,var(--surface) 94%,transparent);border:1px solid var(--line);padding:22px;margin:18px 0}.two-col>.panel{margin:0}.chart-panel{min-height:330px}.chart{height:235px;margin-top:24px}.chart svg{display:block;width:100%;height:100%;overflow:visible}.chart-area{fill:color-mix(in srgb,var(--accent) 9%,transparent)}.chart-line{fill:none;stroke:var(--accent);stroke-width:3;stroke-linejoin:round;stroke-linecap:round}.bars{height:230px;display:flex;gap:4px;align-items:flex-end;margin-top:24px;border-bottom:1px solid var(--line);padding:0 2px}.bars.compact{height:150px}.bar-wrap{height:100%;flex:1;min-width:3px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:8px}.bar{width:100%;max-width:28px;background:linear-gradient(to top,#88520d,var(--accent));border-radius:2px 2px 0 0;min-height:2px}.bar.withheld{background:#4a4c49}.bar.h0{height:2%}.bar.h1{height:5%}.bar.h2{height:10%}.bar.h3{height:15%}.bar.h4{height:20%}.bar.h5{height:25%}.bar.h6{height:30%}.bar.h7{height:35%}.bar.h8{height:40%}.bar.h9{height:45%}.bar.h10{height:50%}.bar.h11{height:55%}.bar.h12{height:60%}.bar.h13{height:65%}.bar.h14{height:70%}.bar.h15{height:75%}.bar.h16{height:80%}.bar.h17{height:85%}.bar.h18{height:90%}.bar.h19{height:95%}.bar.h20{height:100%}.bar-wrap span{font-size:8px;color:var(--dim);height:12px;white-space:nowrap}.table-wrap{overflow-x:auto;margin-top:20px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--dim);font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;padding:12px 14px;border-bottom:1px solid var(--line)}td{padding:15px 14px;border-bottom:1px solid #232523;white-space:nowrap}td:first-child{font-weight:650}td a{text-decoration-color:#51544f;text-underline-offset:3px}.numeric{font-variant-numeric:tabular-nums}.empty{color:var(--dim);padding:30px 4px;text-align:center}.panel-copy,.footnote{color:var(--dim);font-size:13px;line-height:1.5}.big-inline{font-size:28px;font-weight:700;letter-spacing:-.04em}.dimension-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:26px}.dimension{border-top:1px solid var(--line);padding-top:14px}.chips{display:flex;gap:7px;flex-wrap:wrap}.chip{font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d5d3cb;background:var(--raised);border:1px solid var(--line);padding:6px 8px;border-radius:2px}.mini-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);margin-top:22px}.mini-grid>div{background:var(--raised);padding:18px;display:flex;flex-direction:column;gap:12px}.mini-grid strong{font-size:26px}.ranked-list,.status-list{list-style:none;padding:0;margin:18px 0 0}.ranked-list li{display:flex;justify-content:space-between;gap:18px;padding:12px 0;border-bottom:1px solid var(--line);font-size:13px}.status-list li{display:grid;grid-template-columns:10px 1fr auto;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--line);font-size:12px}footer{border-top:1px solid var(--line);padding:24px clamp(18px,4vw,56px);display:flex;justify-content:space-between;gap:20px;color:var(--dim);font-size:12px}footer a{color:var(--fg);text-underline-offset:3px}
.mini-grid.site-grid{grid-template-columns:repeat(3,1fr)}
@media(max-width:1100px){.overview-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:900px){.hero{align-items:flex-start;flex-direction:column}.freshness{width:100%;grid-template-columns:repeat(2,1fr)}.section-head{align-items:flex-start;flex-direction:column}.section-copy{text-align:left}.overview-grid,.metric-grid{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}.dimension-grid{grid-template-columns:repeat(2,1fr)}.mini-grid{grid-template-columns:repeat(2,1fr)}.mini-grid.site-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:560px){main{width:min(100% - 24px,1280px);padding-top:38px}.topbar{padding:0 12px}.top-actions #generated{display:none}.hero{margin-bottom:36px;gap:28px}h1{font-size:40px}.freshness{grid-template-columns:1fr}.metric-card{min-height:130px;padding:16px}.metric-card strong{font-size:34px}.panel{padding:16px}.dimension-grid{grid-template-columns:1fr}.mini-grid{grid-template-columns:1fr 1fr}.bars{gap:2px}footer{flex-direction:column;padding:20px 12px}}
@media(max-width:560px){.mini-grid.site-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`
