import { describe, it, expect, afterEach } from 'vitest'
import { routeIndex, Router } from './route.svelte'

/* The shell reads slide direction from this ordering, so the numbers have to
 * match the order the tab bar draws them in — now on the left, home on the
 * right. */
describe('routeIndex', () => {
  it('numbers the routes in tab bar order', () => {
    expect(routeIndex('now')).toBe(0)
    expect(routeIndex('plan')).toBe(1)
    expect(routeIndex('history')).toBe(2)
    expect(routeIndex('home')).toBe(3)
  })
})

describe('Router', () => {
  afterEach(() => {
    location.hash = ''
  })

  /* The fourth tab was Box; an old link or bookmark still lands on it. */
  it('opens Home from an old #/box link', () => {
    location.hash = '#/box'
    expect(new Router().current).toBe('home')
    location.hash = '#/home'
    expect(new Router().current).toBe('home')
  })
})
