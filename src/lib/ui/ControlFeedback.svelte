<script lang="ts">
  import { feedbackRows, feedbackStatus, feedbackText, feedbackValues, feedbackProof, feedbackSite, feedbackCurve } from '$lib/format/control-feedback.mjs'
  let { value, live = true }: { value: unknown; live?: boolean } = $props()
  const rows = $derived(feedbackRows(value))
</script>

{#if rows.length}
  <section class="control-results" aria-label="Control results">
    <h2>Are you in control?</h2>
    <ul class="control-status-list" aria-label="Control status by device">
      {#each rows as row (`${row.driver}:${row.kind}`)}
        {@const status = feedbackStatus(row,live)}
        <li><span>{row.driver} · {row.kind ?? 'device'}</span><strong data-tone={status.tone}>{status.label}</strong></li>
      {/each}
    </ul>
    {#each rows as row (`${row.driver}:${row.kind}`)}
      {@const text = feedbackText(row, live)}
      {@const curve = feedbackCurve(row,live)}
      <article class:needs-attention={live && row.severity === 'warning'} class:not-current={!live} class:control-alarm={live && row.verification_lost}>
        <div class="device">{row.driver} · {row.kind ?? 'device'}</div>
        <h3>{text.title}</h3>
        <p>{text.detail}</p>
        {#if live && row.device_reason}<p>Device reports: {row.device_reason}</p>{/if}
        <p class="action">{text.action}</p>
        <div class="proof" data-tier={live ? row.verification_tier : undefined}>{feedbackProof(row, live)}</div>
        <p class="action">{feedbackSite(row, live)}</p>
        <details>
          <summary>Request and measurements</summary>
          <dl>{#each feedbackValues(row, live) as [label, value]}<dt>{label}</dt><dd>{value}</dd>{/each}</dl>
          {#if curve}
            <svg viewBox="0 0 280 110" role="img" aria-label={curve.label}>
              <polyline class="zero" points="10,55 270,55" />
              <polyline class="device-line" points={curve.device} />
              <polyline class="site-line" points={curve.site} />
            </svg>
            <p class="time">Device: solid · Adjusted site: dashed · ±{curve.scale} · {curve.duration}</p>
          {/if}
          {#if live && row.site_meter && row.site_after_at_ms}<p class="time">Site meter: {row.site_meter} · {new Date(row.site_after_at_ms).toLocaleTimeString()}</p>{/if}
          {#if row.observed_at_ms}<p class="time">Last device reading: {new Date(row.observed_at_ms).toLocaleTimeString()}</p>{/if}
        </details>
      </article>
    {/each}
  </section>
{/if}

<style>
  .control-results { margin: 1rem 0; }
  h2 { font-size: 1rem; margin: 0 0 .7rem; }
  article { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 12px; padding: 1rem; margin: .6rem 0; overflow-wrap: anywhere; }
  article.needs-attention { border-inline-start: 4px solid var(--fresh-stale); }
  article.not-current { opacity: .7; }
  .device,.action,.time { color: var(--fg-dim); }
  .device { font-size: .8rem; }
  h3 { font-size: 1rem; margin: .3rem 0 .6rem; }
  p { font-size: .9rem; line-height: 1.5; margin: .4rem 0; }
  .proof { font-size: .85rem; font-weight: 600; margin-top: .7rem; }
  .proof[data-tier="2"] { color: var(--energy-export); }
  .proof[data-tier="1"] { color: var(--energy-storage); }
  summary { cursor: pointer; font-size: .85rem; padding-top: .5rem; }
  dl { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem 1rem; font-size: .85rem; }
  dt { color: var(--fg-dim); }
  dd { margin: 0; text-align: right; }
  svg { width: 100%; max-height: 160px; }
  polyline { fill: none; }
  .zero { stroke: var(--line); stroke-width: 1; }
  .device-line { stroke: var(--energy-storage); stroke-width: 3; }
  .site-line { stroke: var(--energy-export); stroke-width: 2; stroke-dasharray: 5 4; }
  .control-status-list { display: flex; flex-wrap: wrap; gap: .6rem; list-style: none; padding: 0; margin: 0 0 1rem; }
  .control-status-list li { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; padding: .65rem .8rem; border: 1px solid var(--line); border-radius: 8px; font-size: .85rem; }
  .control-status-list strong { font-size: .8rem; }
  [data-tone="confirmed"] { color: var(--energy-export); }
  [data-tone="measured"] { color: var(--energy-storage); }
  [data-tone="waiting"] { color: var(--energy-generation); }
  [data-tone="unknown"] { color: var(--fg-dim); }
  [data-tone="alarm"], .control-alarm h3 { color: var(--energy-import); }
  article.control-alarm { border-inline-start: 4px solid var(--energy-import); }
</style>
