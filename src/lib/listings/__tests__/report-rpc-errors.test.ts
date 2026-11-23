import { describe, it, expect } from 'vitest'
import { mapListingReportRpcError } from '../report-rpc-errors'

describe('mapListingReportRpcError', () => {
  it('maps unauthenticated to 401', () => {
    const result = mapListingReportRpcError('not authenticated')
    expect(result.status).toBe(401)
  })

  it('maps an invalid reason to 400', () => {
    const result = mapListingReportRpcError('invalid report reason')
    expect(result.status).toBe(400)
  })

  it('maps a missing listing to 404', () => {
    const result = mapListingReportRpcError('listing not found')
    expect(result.status).toBe(404)
  })

  it('maps a self-report attempt to 403', () => {
    const result = mapListingReportRpcError('you cannot report your own listing')
    expect(result.status).toBe(403)
  })

  it('maps an invalid status transition to 400', () => {
    const result = mapListingReportRpcError('invalid report status')
    expect(result.status).toBe(400)
  })

  it('maps an already-closed report to 404', () => {
    const result = mapListingReportRpcError('report not found or already closed')
    expect(result.status).toBe(404)
  })

  it('maps a reused idempotency key with a different payload to 409', () => {
    const result = mapListingReportRpcError('idempotency key already used with a different request')
    expect(result.status).toBe(409)
    expect(result.error).not.toContain('idempotency')
  })

  it('falls back to a generic 500 for an unrecognized message', () => {
    const result = mapListingReportRpcError('some unexpected database error')
    expect(result.status).toBe(500)
  })

  it('never forwards the raw Postgres message to the client', () => {
    const result = mapListingReportRpcError('not authorized')
    expect(result.error).not.toContain('not authorized')
  })
})
