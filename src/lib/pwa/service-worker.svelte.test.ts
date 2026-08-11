import { afterEach, describe, expect, it, vi } from 'vitest'

interface WorkerStub {
  state: ServiceWorkerState
  postMessage: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function worker(): WorkerStub {
  return {
    state: 'installed',
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

interface RegistrationStub {
  waiting?: ServiceWorker | null
  installing?: ServiceWorker | null
  update: () => Promise<unknown>
}

function installNavigator(registration: RegistrationStub): void {
  const serviceWorker = new EventTarget() as EventTarget & {
    controller: object
    getRegistration: ReturnType<typeof vi.fn>
  }
  serviceWorker.controller = {}
  serviceWorker.getRegistration = vi.fn(
    async () => registration as unknown as ServiceWorkerRegistration
  )
  Object.defineProperty(navigator, 'serviceWorker', {
    value: serviceWorker,
    configurable: true,
  })
}

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('checking for an app update', () => {
  it('keeps the current shell mounted when the build did not change', async () => {
    const update = vi.fn(async () => {})
    installNavigator({ waiting: null, installing: null, update })
    const { checkForAppUpdate } = await import('./service-worker.svelte')

    await expect(checkForAppUpdate()).resolves.toBe(false)
    expect(update).toHaveBeenCalledOnce()
  })

  it('announces a parked build and waits for the Update button', async () => {
    const parked = worker()
    installNavigator({ waiting: parked as unknown as ServiceWorker, update: vi.fn() })
    const { applyAppUpdate, checkForAppUpdate, serviceWorker } = await import(
      './service-worker.svelte'
    )

    await expect(checkForAppUpdate()).resolves.toBe(true)
    expect(serviceWorker.waiting).toBe(true)
    expect(parked.postMessage, 'the update took over before the button was pressed').not.toHaveBeenCalled()

    expect(applyAppUpdate()).toBe(true)
    expect(parked.postMessage).toHaveBeenCalledWith({ type: 'skip-waiting' })
  })
})
