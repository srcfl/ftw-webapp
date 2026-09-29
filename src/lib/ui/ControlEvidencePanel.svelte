<script lang="ts">
  import { onMount } from 'svelte'
  import { portal } from './portal'
  import ControlFeedback from './ControlFeedback.svelte'
  let {value, live, onclose, oncontrols, controlsLabel = 'Device controls'}: {
    value: unknown; live: boolean; onclose: () => void; oncontrols: () => void; controlsLabel?: string
  } = $props()
  let dialog: HTMLDialogElement
  onMount(() => {
    dialog.showModal()
    return () => dialog.close()
  })
</script>

<dialog bind:this={dialog} use:portal aria-label="Control evidence"
  oncancel={(event) => { event.preventDefault(); onclose() }}>
  <header><h2>Control evidence</h2><button onclick={onclose} aria-label="Close control evidence">Close</button></header>
  <ControlFeedback {value} {live} expanded />
  <footer><button onclick={oncontrols}>{controlsLabel}</button></footer>
</dialog>

<style>
  dialog { color: var(--fg); background: var(--surface-raised); border: 1px solid var(--line); border-radius: var(--radius-lg); width: min(38rem, calc(100vw - 2rem)); max-height: 85dvh; padding: var(--space-4); box-sizing: border-box; }
  dialog::backdrop { background: var(--scrim); }
  header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
  h2 { margin: 0; font-size: 1.05rem; }
  button { color: var(--fg); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: .65rem .9rem; cursor: pointer; }
  footer { display: flex; justify-content: flex-end; }
</style>
