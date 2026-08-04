/* Whether to offer the iOS home screen hint.
 *
 * On iOS the home screen is not a convenience. Storage granted to a tab is
 * evicted after a week of not visiting, and push is only available to an
 * installed app — so a phone that never installs loses its cache on the exact
 * schedule that makes the app feel slow. There is no `beforeinstallprompt` to
 * lean on, and the Share sheet cannot be opened by a page, so the only thing
 * left is to say where the button is.
 *
 * Which is worth exactly one sentence, once. Everywhere else — Android, any
 * desktop, any other iOS browser, and an app already on the home screen —
 * shows nothing, because there the browser either does its own prompting or
 * the storage is already durable.
 */

/** Set once the hint has been shown, so a device is never asked twice. */
const SEEN_KEY = 'ftw.install-hint'

export interface InstallEnvironment {
  userAgent: string
  /** iOS Safari only: false in a tab, true from the home screen. */
  standalone: boolean | undefined
  maxTouchPoints: number
}

export function isIosSafariTab(env: InstallEnvironment): boolean {
  const { userAgent: ua } = env

  // An iPad on iPadOS 13+ reports a Mac user agent by default, and is only
  // told apart by having a touchscreen.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1)
  if (!ios) return false

  // Chrome, Firefox, Edge and Opera on iOS. Same engine, different Share
  // sheet, and none of them expose `standalone` — but naming them keeps this
  // readable rather than resting on an absent property.
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false

  return env.standalone === false
}

export function currentEnvironment(): InstallEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean }
  return {
    userAgent: nav.userAgent,
    standalone: nav.standalone,
    maxTouchPoints: nav.maxTouchPoints,
  }
}

export function hintAlreadySeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== null
  } catch {
    // Blocked storage cannot remember a dismissal, so it must not be shown a
    // hint it would repeat on every launch.
    return true
  }
}

export function markHintSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* Nothing to do, and nothing depends on it. */
  }
}
