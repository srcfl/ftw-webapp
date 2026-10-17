import { describe, it, expect } from 'vitest'
import { routeIndex } from './route.svelte'

/* The shell reads slide direction from this ordering, so the numbers have to
 * match the order the tab bar draws them in — now on the left, box on the
 * right. */
describe('routeIndex', () => {
  it('numbers the routes in tab bar order', () => {
    expect(routeIndex('now')).toBe(0)
    expect(routeIndex('plan')).toBe(1)
    expect(routeIndex('history')).toBe(2)
    expect(routeIndex('box')).toBe(3)
  })
})
