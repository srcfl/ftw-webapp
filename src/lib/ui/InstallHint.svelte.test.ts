/* The hint's one control, as voice control reaches it.
 *
 * Someone steering by voice says the word they can see. The button used to
 * carry aria-label="Dismiss" over visible text saying "Close", so "tap
 * Close" matched nothing — the accessible name and the printed one must be
 * the same word.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'

// The hint decides once, from the real environment, whether to exist at
// all. What is under test is the button, not the iOS detection — so the
// gate is held open.
vi.mock('$lib/pwa/install', () => ({
  currentEnvironment: () => ({}),
  hintAlreadySeen: () => false,
  isIosSafariTab: () => true,
  markHintSeen: () => {},
}))

import InstallHint from './InstallHint.svelte'

describe('the install hint', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('names its button by the word printed on it', async () => {
    render(InstallHint)

    const button = await screen.findByRole('button', { name: 'Close' })
    expect(button.getAttribute('aria-label'), 'an aria-label overrode the visible word').toBeNull()
  })
})
