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
  addEventListener?: ReturnType<typeof vi.fn>
}

function installNavigator(registration: RegistrationStub): void {
  const serviceWorker = new EventTarget() as EventTarget & {
    controller: object
    getRegistration: ReturnType<typeof vi.fn>
    register: ReturnType<typeof vi.fn>
  }
  serviceWorker.controller = {}
  serviceWorker.getRegistration = vi.fn(
    async () => registration as unknown as ServiceWorkerRegistration
  )
  serviceWorker.register = vi.fn(async () => registration as unknown as ServiceWorkerRegistration)
  Object.defineProperty(navigator, 'serviceWorker', {
    value: serviceWorker,
    configurable: true,
  })
}

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('checking for an app update', () => {
  it('keeps the current shell mounted when the build did not change', async () => {
    const update = vi.fn(async () => {})
    installNavigator({ waiting: null, installing: null, update })
    const { checkForAppUpdate } = await import('./service-worker.svelte')

    await expect(checkForAppUpdate()).resolves.toBe(false)
    expect(update).toHaveBeenCalledOnce()
  })

  it('keeps a ready build parked while the app is visible', async () => {
    const parked = worker()
    installNavigator({ waiting: parked as unknown as ServiceWorker, update: vi.fn() })
    const { checkForAppUpdate } = await import('./service-worker.svelte')

    await expect(checkForAppUpdate()).resolves.toBe(true)
    expect(parked.postMessage, 'the update replaced a visible page').not.toHaveBeenCalled()
  })

  it('lands a ready build without asking when the app is hidden', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const parked = worker()
    installNavigator({ waiting: parked as unknown as ServiceWorker, update: vi.fn() })
    const { checkForAppUpdate } = await import('./service-worker.svelte')

    await expect(checkForAppUpdate()).resolves.toBe(true)
    expect(parked.postMessage).toHaveBeenCalledWith({ type: 'skip-waiting' })
  })

  it('lands a build already waiting at launch', async () => {
    vi.stubEnv('PROD', true)
    const parked = worker()
    installNavigator({
      waiting: parked as unknown as ServiceWorker,
      update: vi.fn(),
      addEventListener: vi.fn(),
    })
    const { registerServiceWorker } = await import('./service-worker.svelte')

    await registerServiceWorker()
    expect(parked.postMessage).toHaveBeenCalledWith({ type: 'skip-waiting' })
  })

  it('checks again when a kept-alive app returns to the foreground', async () => {
    vi.stubEnv('PROD', true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const update = vi.fn(async () => {})
    installNavigator({
      waiting: null,
      installing: null,
      update,
      addEventListener: vi.fn(),
    })
    const listen = vi.spyOn(document, 'addEventListener')
    const { registerServiceWorker } = await import('./service-worker.svelte')
    await registerServiceWorker()

    const visibilityListener = listen.mock.calls.find(([type]) => type === 'visibilitychange')?.[1]
    expect(visibilityListener).toBeTypeOf('function')
    ;(visibilityListener as EventListener)(new Event('visibilitychange'))

    expect(update).toHaveBeenCalledOnce()
  })
})
