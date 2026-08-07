<!--
  A payload as a square, and only as a square.

  The one way a pairing payload is allowed to travel is a camera. It carries
  the box's static key, a live pairing code and the rendezvous secret — the
  whole of what it takes to become a phone this house trusts — so it must not
  be selectable, copyable, screenshot-friendly text. The box's own settings
  page states the rule beside its drawing and this is the app keeping it.

  The encoder is the box's, vendored: $vendor/ftw/qrcode.js hands back a
  boolean matrix and leaves the painting here. It is imported when there is
  something to draw and never before — nothing in the launch path needs it.

  Painted as one SVG path rather than a canvas. It stays sharp at any size, it
  needs no device pixel ratio arithmetic, and it is in the document rather than
  behind a drawing context — which is what lets a test read back what was drawn
  and decode it.
-->
<script lang="ts" module>
  /** Modules of margin. Below four, cameras stop finding the symbol. */
  export const QUIET = 4

  /**
   * One `d` for the whole symbol: a unit square per dark module.
   *
   * One path rather than a rect per module because a type 9 symbol is 53×53
   * and half its modules are dark — that is fourteen hundred elements against
   * one attribute.
   */
  export function modulePath(matrix: boolean[][]): string {
    let d = ''
    for (let row = 0; row < matrix.length; row++) {
      for (let col = 0; col < matrix.length; col++) {
        if (matrix[row]![col]) d += `M${col + QUIET} ${row + QUIET}h1v1h-1Z`
      }
    }
    return d
  }
</script>

<script lang="ts">
  interface Props {
    /** What a camera will read back. */
    text: string
    /** Said out loud by a screen reader, since the square itself says nothing. */
    label: string
  }

  let { text, label }: Props = $props()

  async function draw(payload: string) {
    const { qrMatrix } = await import('$vendor/ftw/qrcode.js')
    const matrix = qrMatrix(payload)
    return { span: matrix.length + 2 * QUIET, d: modulePath(matrix) }
  }
</script>

{#await draw(text)}
  <!-- A module-load and some arithmetic. Deliberately nothing: a spinner here
       would be a spinner for a few milliseconds of local work. -->
  <div class="slot"></div>
{:then symbol}
  <svg
    class="slot"
    viewBox="0 0 {symbol.span} {symbol.span}"
    shape-rendering="crispEdges"
    role="img"
    aria-label={label}
  >
    <!-- Dark on light whatever the app's theme. An inverted QR is one many
         phone cameras will not read, and the quiet zone has to be light too,
         which is why the background covers the whole viewBox. -->
    <rect width={symbol.span} height={symbol.span} fill="#ffffff" />
    <path d={symbol.d} fill="#000000" />
  </svg>
{:catch}
  <p class="fallback">
    This code could not be drawn here. Show it from your box's own page
    instead.
  </p>
{/await}

<style>
  /* As large as a narrow screen allows, because how big a module is decides
     whether a camera reads it at arm's length. A real pairing payload is a
     53-module symbol, so 18rem is about four and a half pixels a module on a
     375 px phone — the same density the box's own page draws at. */
  .slot {
    display: block;
    width: 100%;
    max-width: 18rem;
    aspect-ratio: 1;
    border-radius: var(--radius-sm);
  }

  .fallback {
    color: var(--fg-dim);
    max-width: 30rem;
  }
</style>
