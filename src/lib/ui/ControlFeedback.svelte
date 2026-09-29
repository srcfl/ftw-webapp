<script lang="ts">
  import { feedbackRows, feedbackText, feedbackValues, feedbackProof, feedbackSite } from '$lib/format/control-feedback.mjs'
  let { value, live = true }: { value: unknown; live?: boolean } = $props()
  const rows = $derived(feedbackRows(value))
</script>

{#if rows.length}
  <section class="control-results" aria-label="Control results">
    <h2>Are you in control?</h2>
    {#each rows as row (`${row.driver}:${row.kind}`)}
      {@const text = feedbackText(row, live)}
      <article class:needs-attention={live && row.severity === 'warning'} class:not-current={!live}>
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
</style>
