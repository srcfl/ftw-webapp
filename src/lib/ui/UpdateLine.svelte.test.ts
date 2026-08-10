/* A ready app build must be usable from the screen that announces it.
 *
 * iOS may keep a standalone page alive for days. A status line that only says
 * "next launch" leaves force-closing as the hidden control; the visible word
 * Update is now that control, and it reaches the service-worker handover.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'

const seam = vi.hoisted(() => ({
  state: { waiting: true, applying: false },
  apply: vi.fn(() => true),
}))

vi.mock('$lib/pwa/service-worker.svelte', () => ({
  serviceWorker: seam.state,
  applyAppUpdate: seam.apply,
}))

import UpdateLine from './UpdateLine.svelte'

describe('a ready web app update', () => {
  beforeEach(() => {
    seam.state.waiting = true
    seam.state.applying = false
    seam.apply.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('offers the handover instead of asking for a force-close', () => {
    render(UpdateLine)

    expect(screen.getByRole('status').textContent).toMatch(/new version is ready/i)
    const update = screen.getByRole('button', { name: 'Update' })
    update.click()

    expect(seam.apply).toHaveBeenCalledOnce()
  })

  it('cannot ask for the same handover twice while it is applying', () => {
    seam.state.applying = true
    render(UpdateLine)

    const update = screen.getByRole('button', { name: 'Updating…' }) as HTMLButtonElement
    expect(update.disabled).toBe(true)
    update.click()
    expect(seam.apply).not.toHaveBeenCalled()
  })
})
