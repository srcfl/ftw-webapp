// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/svelte'
import { afterEach, expect, it } from 'vitest'
import ControlFeedback from './ControlFeedback.svelte'
afterEach(cleanup)

const row = (extra: Record<string, unknown> = {}) => ({
  driver: 'Sungrow', kind: 'battery', mode: 'planner_arbitrage', status: 'following', reason: 'power_observed',
  severity: 'info', evidence: 'measured', readings_fresh: true, sent_w: -2250, actual_w: -2249, readback_w: -2250,
  command_at_ms: 1, observed_at_ms: 2, site_confirmation: 'device_response_unconfirmed', ...extra,
})

it('answers first, in words, without tier numbers', () => {
  render(ControlFeedback, { value: [row({ evidence: 'confirmed', confirmed_at_ms: 3 })] })
  expect(screen.getByText('Are we in control?')).toBeTruthy()
  expect(screen.getByRole('heading', { name: /Following FTW/ })).toBeTruthy()
  expect(screen.getByText('Discharging 2.2 kW as planned.')).toBeTruthy()
  expect(screen.getByText(/The grid meter confirmed this at/)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/tier/i)
  expect(document.querySelector('details')!.open).toBe(false)
})

it('says what is wrong and what the owner can do', () => {
  render(ControlFeedback, { value: [row({ status: 'not_following', reason: 'no_power_response', severity: 'warning', sent_w: 3000, actual_w: 0 })] })
  expect(screen.getByRole('heading', { name: /Not following/ })).toBeTruthy()
  expect(screen.getByText('Asked for 3.0 kW charge, but it delivers no power.')).toBeTruthy()
  expect(screen.getByText('The battery has not said why. Check its app or display.')).toBeTruthy()
  expect(document.querySelector('.block')!.getAttribute('data-tone')).toBe('warning')
})

it('raises lost control as an alarm and shows nothing old as current', async () => {
  const lost = row({ status: 'no_contact', reason: 'readings_lost', severity: 'alarm', evidence: 'accepted', readings_fresh: false, actual_w: null })
  const view = render(ControlFeedback, { value: [lost] })
  expect(screen.getByRole('heading', { name: /Lost control/ })).toBeTruthy()
  expect(document.querySelector('.block')!.getAttribute('data-tone')).toBe('alarm')
  expect(screen.getByText('No fresh readings')).toBeTruthy()
  await view.rerender({ value: [row()], live: false })
  expect(screen.getByRole('heading', { name: /Status not current/ })).toBeTruthy()
  expect(screen.queryByText('Discharging 2.2 kW as planned.')).toBeNull()
  expect(screen.getAllByText('Not current').length).toBe(2)
})

it('renders device reasons as text', () => {
  render(ControlFeedback, { value: [row({ driver: '<script>bad</script>', kind: 'device', status: 'not_following', reason: 'device_fault', severity: 'alarm', device_reason: '<img onerror=bad>' })] })
  expect(document.querySelector('script')).toBeNull()
  expect(document.querySelector('img')).toBeNull()
  expect(screen.getByText('The device reports a fault: <img onerror=bad>.')).toBeTruthy()
})

it('keeps an open receipt open while the status changes', async () => {
  const view = render(ControlFeedback, { value: [row()] })
  const receipt = document.querySelector('details')!
  receipt.open = true
  await view.rerender({ value: [row({ status: 'not_following', reason: 'setpoint_changed', severity: 'warning', readback_w: -1500 })] })
  expect(document.querySelector('details')).toBe(receipt)
  expect(receipt.open).toBe(true)
  expect(screen.getByText('The battery reports a target of 1.5 kW discharge, not the 2.3 kW discharge FTW sent.')).toBeTruthy()
})

it('shows numbers and the response curve for experts, and drops them when stale', async () => {
  const evidence = { samples: 3, window_s: 10, unexplained_change_w: 10, device_change_w: -1000, trace: [0, 1, 2].map(i => ({ at_ms: 1000 + i * 5000, device_change_w: -i * 500, adjusted_site_change_w: -i * 500 - 10 })) }
  const view = render(ControlFeedback, { value: [row({ evidence: 'confirmed', site_confirmation: 'confirmed', site_evidence: evidence })] })
  expect(screen.getByRole('img', { name: /Measured changes over 10 seconds/ })).toBeTruthy()
  expect(screen.getByText('10 W more drawn')).toBeTruthy()
  expect(screen.getByText('1.0 kW toward discharge')).toBeTruthy()
  await view.rerender({ value: [row({ evidence: 'confirmed', site_evidence: evidence })], live: false })
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.queryByText('10 W more drawn')).toBeNull()
})
