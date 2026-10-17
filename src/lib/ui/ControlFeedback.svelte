<!--
  "Are we in control?" for one device sheet. The box decides the status, its
  severity and the evidence; this component only renders the words the box's
  own dashboard uses. Keyed blocks keep an open "How FTW knows" open while
  the status refreshes.
-->
<script lang="ts">
  import {
    controlRows,
    controlStatus,
    controlReceipt,
    controlNumbers,
    controlCurve,
  } from '$vendor/ftw/control-feedback.js'

  let { value, live = true }: { value: unknown; live?: boolean } = $props()
  const rows = $derived(controlRows(value))
  const ICONS: Record<string, string> = { ok: '✓', neutral: '•', warning: '▲', alarm: '!', stale: '…' }
</script>

{#if rows.length}
  <section class="control" aria-label="Are we in control?">
    <p class="question">Are we in control?</p>
    {#each rows as row (`${row.driver}:${row.kind}`)}
      {@const status = controlStatus(row, live)}
      {@const numbers = controlNumbers(row, live)}
      {@const curve = controlCurve(row, live)}
      <div class="block" data-tone={status.tone}>
        <h3><span class="icon" aria-hidden="true">{ICONS[status.tone] ?? ICONS.neutral}</span>{status.title}</h3>
        <p class="text">{status.text}</p>
        {#if status.proof}<p class="proof">{status.proof}</p>{/if}
        {#if status.next}<p class="next">{status.next}</p>{/if}
        <details>
          <summary>How FTW knows</summary>
          <ol>
            {#each controlReceipt(row, live) as step (step.step)}
              <li data-state={step.state}><span class="step">{step.step}</span><span>{step.value}</span></li>
            {/each}
          </ol>
          {#if numbers.length || curve}
            <details>
              <summary>Numbers</summary>
              <dl>
                {#each numbers as [label, text] (label)}<dt>{label}</dt><dd>{text}</dd>{/each}
              </dl>
              {#if curve}
                <svg viewBox="0 0 280 110" role="img" aria-label={curve.label}>
                  <polyline class="zero" points="10,55 270,55" />
                  <polyline class="device-line" points={curve.device} />
                  <polyline class="site-line" points={curve.site} />
                </svg>
              {/if}
            </details>
          {/if}
        </details>
      </div>
    {/each}
  </section>
{/if}

<style>
  .control { margin: 0 0 var(--space-3, 12px); }
  .question {
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--fg-muted);
    margin: 0 0 8px;
  }
  .block {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    margin: 0 0 10px;
    background: var(--surface-raised);
  }
  .block[data-tone='warning'] { border-color: var(--amber); }
  .block[data-tone='alarm'] { border-color: var(--red-e); }
  .block[data-tone='stale'] { opacity: 0.75; }
  h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 4px;
  }
  .icon {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    background: var(--line);
    color: var(--fg-dim);
  }
  [data-tone='ok'] .icon { background: color-mix(in srgb, var(--green-e) 22%, transparent); color: var(--green-e); }
  [data-tone='warning'] .icon { background: color-mix(in srgb, var(--amber) 22%, transparent); color: var(--amber); }
  [data-tone='alarm'] .icon { background: var(--red-e); color: var(--on-accent); }
  p { margin: 0; font-size: 0.92rem; line-height: 1.45; }
  .proof, .next { margin-top: 4px; font-size: 0.85rem; color: var(--fg-dim); }
  .next { color: var(--fg); }
  details { margin-top: 8px; }
  summary { cursor: pointer; font-size: 0.82rem; color: var(--fg-dim); padding: 4px 0; }
  ol { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 6px; }
  li { display: grid; grid-template-columns: 6.5rem 1fr; gap: 8px; align-items: baseline; font-size: 0.85rem; overflow-wrap: anywhere; }
  .step { display: flex; align-items: center; gap: 6px; color: var(--fg-dim); }
  .step::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--fg-muted); }
  li[data-state='done'] .step::before { background: var(--green-e); border-color: var(--green-e); }
  li[data-state='wait'] .step::before { border-style: dashed; }
  li[data-state='fail'] .step::before { background: var(--red-e); border-color: var(--red-e); }
  li[data-state='none'] { opacity: 0.65; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 6px 0; font-size: 0.82rem; }
  dt { color: var(--fg-dim); }
  dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  svg { width: 100%; max-height: 140px; }
  polyline { fill: none; }
  .zero { stroke: var(--line); stroke-width: 1; }
  .device-line { stroke: var(--cyan); stroke-width: 3; }
  .site-line { stroke: var(--green-e); stroke-width: 2; stroke-dasharray: 5 4; }
</style>
