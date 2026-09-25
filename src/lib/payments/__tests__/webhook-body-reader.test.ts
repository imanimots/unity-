import { describe, it, expect } from 'vitest'
import { readBoundedRequestBody, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES } from '../webhook-body-reader'

function requestWithBody(body: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request('https://example.test/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', ...extraHeaders } })
}

describe('readBoundedRequestBody', () => {
  it('reads a body under the limit and preserves it exactly as bytes', async () => {
    const body = JSON.stringify({ hello: 'world' })
    const result = await readBoundedRequestBody(requestWithBody(body), ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(Buffer.compare(result.bytes, Buffer.from(body, 'utf-8'))).toBe(0)
  })

  it('P5D-B.1: returns the literal Buffer, never a decoded string -- preserves bytes that are not valid UTF-8 unchanged', async () => {
    const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d])
    const request = new Request('https://example.test/webhook', { method: 'POST', body: new Uint8Array(invalidUtf8), headers: { 'content-type': 'application/json' } })
    const result = await readBoundedRequestBody(request, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(Buffer.compare(result.bytes, invalidUtf8)).toBe(0)
  })

  it('accepts a body exactly at the limit', async () => {
    const body = 'a'.repeat(ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    const result = await readBoundedRequestBody(requestWithBody(body), ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    expect(result.ok).toBe(true)
  })

  it('rejects a body one byte over the limit', async () => {
    const body = 'a'.repeat(ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES + 1)
    const result = await readBoundedRequestBody(requestWithBody(body), ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    expect(result).toEqual({ ok: false, reason: 'body_exceeded_limit' })
  })

  it('rejects early via Content-Length when it declares a size over the limit, without reading the stream', async () => {
    // A request whose declared Content-Length lies about being huge --
    // the implementation must reject based on the header alone here,
    // not wait to stream (small) actual bytes.
    const result = await readBoundedRequestBody(requestWithBody('small body', { 'content-length': String(10 * 1024 * 1024) }), ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    expect(result).toEqual({ ok: false, reason: 'content_length_exceeded' })
  })

  it('does not trust Content-Length alone -- a body that streams more than a small/absent declared length is still caught', async () => {
    const oversized = 'x'.repeat(ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES + 500)
    // Force a mismatched/absent content-length by using a ReadableStream
    // body directly (fetch's Request won't let us lie about
    // content-length via the header when body is a plain string, so we
    // build a stream whose declared length the Request infers as
    // undefined/chunked).
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized))
        controller.close()
      },
    })
    const request = new Request('https://example.test/webhook', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    const result = await readBoundedRequestBody(request, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    expect(result).toEqual({ ok: false, reason: 'body_exceeded_limit' })
  })

  it('stops reading once the byte limit is exceeded during a streamed/chunked body, rather than buffering the whole thing', async () => {
    let chunksProduced = 0
    const chunkSize = 1024
    const totalChunks = 200 // way more than the 64 KiB limit at 1 KiB/chunk
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksProduced >= totalChunks) {
          controller.close()
          return
        }
        chunksProduced += 1
        controller.enqueue(new TextEncoder().encode('x'.repeat(chunkSize)))
      },
    })
    const request = new Request('https://example.test/webhook', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    const result = await readBoundedRequestBody(request, ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    expect(result).toEqual({ ok: false, reason: 'body_exceeded_limit' })
    // Must have stopped well short of producing all 200 chunks (200 KiB) --
    // proves it didn't buffer the entire attacker-controlled stream.
    expect(chunksProduced).toBeLessThan(totalChunks)
  })

  it('handles an empty body safely', async () => {
    const result = await readBoundedRequestBody(requestWithBody(''), ORCHESTRATION_WEBHOOK_BODY_LIMIT_BYTES)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.bytes.byteLength).toBe(0)
  })
})
