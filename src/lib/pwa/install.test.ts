import { describe, it, expect } from 'vitest'
import { isIosSafariTab, type InstallEnvironment } from './install.ts'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP_MODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const IPHONE_CHROME = `${IPHONE_SAFARI.replace('Version/17.5', 'CriOS/126.0.6478.54')}`
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const MAC_SAFARI = IPAD_DESKTOP_MODE

const env = (over: Partial<InstallEnvironment>): InstallEnvironment => ({
  userAgent: IPHONE_SAFARI,
  standalone: false,
  maxTouchPoints: 5,
  ...over,
})

describe('the iOS home screen hint', () => {
  it('offers on an iPhone in a Safari tab', () => {
    expect(isIosSafariTab(env({}))).toBe(true)
  })

  it('offers on an iPad reporting a Mac user agent', () => {
    expect(isIosSafariTab(env({ userAgent: IPAD_DESKTOP_MODE, maxTouchPoints: 5 }))).toBe(true)
  })

  it('says nothing to an app already on the home screen', () => {
    expect(isIosSafariTab(env({ standalone: true }))).toBe(false)
  })

  // Everywhere below, either the browser prompts for installation itself or
  // the hint would name a menu item that is not there.
  it('says nothing on a real Mac', () => {
    expect(isIosSafariTab(env({ userAgent: MAC_SAFARI, maxTouchPoints: 0, standalone: undefined }))).toBe(
      false
    )
  })

  it('says nothing on Android', () => {
    expect(isIosSafariTab(env({ userAgent: ANDROID_CHROME, standalone: undefined }))).toBe(false)
  })

  it('says nothing in another browser on iOS', () => {
    expect(isIosSafariTab(env({ userAgent: IPHONE_CHROME, standalone: undefined }))).toBe(false)
  })
})
