/* Park a node on the app shell, outside the scrolling view.
 *
 * Sheets are `position: fixed`. Inside `main` that is a lie on a phone: the
 * scroller, and the pull-to-refresh layer's `will-change: transform`, both
 * become the containing block, so a bottom sheet lands at the bottom of the
 * page and the browser scrolls it into view. Moving the node onto `.app`
 * keeps it on the screen someone is looking at.
 */

export type PortalTarget = string | HTMLElement | undefined

function resolve(target: PortalTarget): HTMLElement {
  if (target instanceof HTMLElement) return target
  const selector = target ?? '.overlays, .app'
  return document.querySelector<HTMLElement>(selector) ?? document.body
}

/**
 * Svelte action: move this element to the shell (or `document.body` in tests
 * that have no shell) and take it with the component when it unmounts.
 */
export function portal(node: HTMLElement, target?: PortalTarget) {
  const place = (next: PortalTarget) => {
    const dest = resolve(next)
    if (node.parentElement !== dest) dest.append(node)
  }

  place(target)
  return {
    update(next: PortalTarget) {
      place(next)
    },
    destroy() {
      node.remove()
    },
  }
}
