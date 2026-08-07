/* Types for the vendored component — the surface the app actually uses.
 * The implementation is the box's own file, untouched; see the header there.
 */

/** One column. `value` drives the height; everything else is what is read. */
export interface FtwBarChartDatum {
  /** Short string under the bar. */
  label: string
  /** Numeric, relative to the largest in the set. */
  value: number
  /** Pre-formatted string above the bar. Without it the component picks. */
  displayValue?: string
  /** Tooltip on the column. */
  title?: string
}

export interface FtwBarChartElement extends HTMLElement {
  data: FtwBarChartDatum[]
}
