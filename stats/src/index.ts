import { accessIdentity } from './access.ts'
import { dashboardDocument } from './dashboard.ts'
import { collectGitHub } from './github.ts'
import { ingestRelay } from './relay.ts'
import { collectSiteTraffic } from './site.ts'
import { dashboardData } from './store.ts'
import type { AppEnv } from './types.ts'

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return new Response('ok\n', {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        })
      }

      if (request.method === 'POST' && url.pathname === '/api/ingest/relay') {
        return withSecurityHeaders(await ingestRelay(request, env))
      }

      if (request.method === 'GET' && url.pathname === '/api/public') {
        return withSecurityHeaders(
          Response.json(await dashboardData(env, false), {
            headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' },
          })
        )
      }

      if (request.method === 'GET' && url.pathname === '/api/admin') {
        const identity = await accessIdentity(request, env)
        if (!identity) return withSecurityHeaders(forbidden())
        return withSecurityHeaders(
          Response.json(await dashboardData(env, true), {
            headers: { 'cache-control': 'no-store' },
          })
        )
      }

      if (request.method === 'GET' && url.pathname === '/') {
        return htmlResponse(false)
      }

      if (request.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
        const identity = await accessIdentity(request, env)
        if (!identity) return withSecurityHeaders(forbidden())
        return htmlResponse(true)
      }

      return withSecurityHeaders(
        new Response('not found\n', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        })
      )
    } catch (error) {
      console.error('stats: request failed', {
        path: url.pathname,
        kind: error instanceof Error ? error.name : 'unknown',
      })
      return withSecurityHeaders(
        Response.json(
          { error: 'stats are temporarily unavailable' },
          { status: 500, headers: { 'cache-control': 'no-store' } }
        )
      )
    }
  },

  async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
    const daily = controller.cron === '17 0 * * *'
    const failures: string[] = []
    try {
      await collectGitHub(env, daily, controller.scheduledTime)
    } catch (error) {
      failures.push('github')
      console.error('stats: scheduled GitHub collection failed', {
        kind: error instanceof Error ? error.name : 'unknown',
      })
    }
    if (daily) {
      try {
        await collectSiteTraffic(env, controller.scheduledTime)
      } catch (error) {
        failures.push('site')
        console.error('stats: scheduled site collection failed', {
          kind: error instanceof Error ? error.name : 'unknown',
        })
      }
    }
    await env.DB.prepare('DELETE FROM collector_runs WHERE finished_at < ?')
      .bind(new Date(controller.scheduledTime - 90 * 24 * 60 * 60_000).toISOString())
      .run()
    if (failures.length > 0) throw new Error('one or more scheduled collectors failed')
  },
} satisfies ExportedHandler<AppEnv>

function htmlResponse(privateView: boolean): Response {
  const document = dashboardDocument(privateView)
  return withSecurityHeaders(
    new Response(document.html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': privateView ? 'no-store' : 'public, max-age=300',
        'content-security-policy': [
          "default-src 'none'",
          `script-src 'nonce-${document.nonce}'`,
          `style-src 'nonce-${document.nonce}'`,
          "connect-src 'self'",
          "img-src 'self' data:",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      },
    })
  )
}

function forbidden(): Response {
  return Response.json(
    { error: 'Cloudflare Access is required' },
    { status: 403, headers: { 'cache-control': 'no-store' } }
  )
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('referrer-policy', 'no-referrer')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('x-frame-options', 'DENY')
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()')
  headers.set('cross-origin-resource-policy', 'same-origin')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
