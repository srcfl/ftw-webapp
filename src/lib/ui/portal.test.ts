import { describe, expect, it } from 'vitest'
import { portal } from './portal'

describe('portal', () => {
  it('moves the node onto the app shell so fixed sheets are not in the scroller', () => {
    const app = document.createElement('div')
    app.className = 'app'
    const scroller = document.createElement('main')
    const sheet = document.createElement('div')
    scroller.append(sheet)
    app.append(scroller)
    document.body.append(app)

    const action = portal(sheet)
    expect(sheet.parentElement).toBe(app)
    expect(scroller.contains(sheet)).toBe(false)

    action.destroy()
    expect(sheet.isConnected).toBe(false)
    app.remove()
  })

  it('falls back to the document when there is no shell', () => {
    const sheet = document.createElement('div')
    document.body.append(sheet)
    const action = portal(sheet)
    expect(sheet.parentElement).toBe(document.body)
    action.destroy()
  })
})
