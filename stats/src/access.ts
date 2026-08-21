import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AccessIdentity, AppEnv } from './types.ts'

export async function accessIdentity(request: Request, env: AppEnv): Promise<AccessIdentity | null> {
  const audience = env.ACCESS_AUD
  const teamDomain = validTeamDomain(env.ACCESS_TEAM_DOMAIN)
  const token = request.headers.get('cf-access-jwt-assertion')
  if (!audience || !teamDomain || !token) return null

  try {
    const keySet = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain))
    const { payload } = await jwtVerify(token, keySet, {
      algorithms: ['RS256'],
      audience,
      issuer: teamDomain.origin,
    })
    if (payload['type'] !== 'app' || typeof payload['email'] !== 'string') return null
    return { email: payload['email'] }
  } catch {
    return null
  }
}

function validTeamDomain(value: string | undefined): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.cloudflareaccess.com') ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null
    }
    return url
  } catch {
    return null
  }
}
