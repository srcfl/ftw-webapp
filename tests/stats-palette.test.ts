import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dashboardDocument } from '../stats/src/dashboard.ts'

// The stats Worker serves its own page and cannot load the app's
// stylesheet, so it carries a copy of the roles it uses. This holds the
// copy to src/styles/tokens.css in both themes.
const tokens = readFileSync('src/styles/tokens.css', 'utf8')
const [tokensDark = '', tokensLight = ''] = tokens.split("html[data-theme='light']")

function value(css: string, name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;}]+)[;}]`).exec(css)?.[1]?.trim()
}

const page = dashboardDocument(false).html
const styles = /<style[^>]*>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? ''
const [statsDark = '', statsLight = ''] = styles.split('@media(prefers-color-scheme:light)')

// Stats name → the app's role.
const ROLES: Record<string, string> = {
  bg: 'surface',
  surface: 'surface-raised',
  raised: 'surface-elevated',
  line: 'line',
  fg: 'fg',
  dim: 'fg-dim',
  muted: 'fg-muted',
  live: 'live',
  alarm: 'alarm',
}

describe('stats page palette', () => {
  it('takes the app palette in both themes', () => {
    for (const [name, role] of Object.entries(ROLES)) {
      const dark = value(tokensDark, role)
      const light = value(tokensLight, role) ?? dark
      expect(value(statsDark, name), `${name} dark`).toBe(dark)
      expect(value(statsLight.slice(0, statsLight.indexOf('}}') + 2), name), `${name} light`).toBe(light)
    }
    expect(page).toContain('<meta name="color-scheme" content="dark light">')
  })

  it('keeps raw colours in the two token blocks only', () => {
    const rules = styles
      .replace(/:root\{[^}]*\}/, '')
      .replace(/@media\(prefers-color-scheme:light\)\{:root\{[^}]*\}\}/, '')
    expect(rules.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([])
  })
})
