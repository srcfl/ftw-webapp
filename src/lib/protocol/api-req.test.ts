import { describe, expect, it } from 'vitest'
import { API_MAX_BYTES, apiReqFields } from './messages'

describe('api.req, as the iPhone app encodes it', () => {
  it('sends the ceiling, the method and the path, and nothing empty', () => {
    expect(apiReqFields({ method: 'GET', path: '/api/status', query: {}, stepUp: false })).toEqual({
      maxBytes: API_MAX_BYTES,
      method: 'GET',
      path: '/api/status',
    })
  })

  it('sorts query keys and keeps a caller ceiling and a real step-up', () => {
    const fields = apiReqFields({
      method: 'GET',
      path: '/api/energy/history',
      query: { scope: 'system', bucket: '1h', since: '1', until: '2' },
      maxBytes: 64,
      stepUp: true,
    })
    expect(Object.keys(fields)).toEqual(['maxBytes', 'method', 'path', 'query', 'stepUp'])
    expect(Object.keys(fields.query!)).toEqual(['bucket', 'scope', 'since', 'until'])
    expect(fields.maxBytes).toBe(64)
    expect(fields.stepUp).toBe(true)
  })
})
