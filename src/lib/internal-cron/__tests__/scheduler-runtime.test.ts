import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync, symlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import yaml from 'js-yaml'

/**
 * P5D-VERCEL-FIX.1: proves the ACTUAL committed dispatch script (not a
 * hand-copied mirror) performs exactly one request per route per tick,
 * never retries on any outcome, isolates one route's failure from a
 * sibling sharing the same schedule, and propagates failure to the
 * process exit code -- the runtime behavior the prior, purely static
 * scheduler-config tests could not exercise. Runs the real extracted
 * bash script under a fake `curl` on PATH; no network, no real
 * endpoint, no secret, no GitHub API call.
 */

const REPO_ROOT = resolve(__dirname, '../../../..')
const FAKE_CURL_SRC = resolve(__dirname, 'fixtures/fake-curl.sh')

function extractRunScript(): string {
  const raw = readFileSync(resolve(REPO_ROOT, '.github/workflows/internal-cron-scheduler.yml'), 'utf8')
  const doc = yaml.load(raw) as { jobs: { dispatch: { steps: Array<{ run: string }> } } }
  return doc.jobs.dispatch.steps[0].run
}

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'scheduler-runtime-'))
  const fakeBin = join(workDir, 'bin')
  mkdirSync(fakeBin)
  const curlDest = join(fakeBin, 'curl')
  writeFileSync(curlDest, readFileSync(FAKE_CURL_SRC))
  chmodSync(curlDest, 0o755)
  // Real jq must still resolve -- symlink the system's jq into the same
  // fake bin dir up front so PATH can be narrowed to ONLY this dir
  // (never risking a different curl earlier on the real PATH).
  const systemJq = execFileSync('/usr/bin/which', ['jq']).toString().trim()
  symlinkSync(systemJq, join(fakeBin, 'jq'))
  const systemMktemp = execFileSync('/usr/bin/which', ['mktemp']).toString().trim()
  symlinkSync(systemMktemp, join(fakeBin, 'mktemp'))
  const systemRm = execFileSync('/usr/bin/which', ['rm']).toString().trim()
  symlinkSync(systemRm, join(fakeBin, 'rm'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** Runs the real extracted dispatch script with a route->mode config, returning exit code, call log, and stdout. */
function runDispatch(
  schedule: string,
  routeConfig: Record<string, { mode: string }>
): { exitCode: number; calls: string[]; stdout: string } {
  const scriptPath = join(workDir, 'dispatch.sh')
  writeFileSync(scriptPath, extractRunScript())
  const configPath = join(workDir, 'config.json')
  writeFileSync(configPath, JSON.stringify(routeConfig))
  const logPath = join(workDir, 'calls.log')
  writeFileSync(logPath, '')

  let exitCode = 0
  let stdout = ''
  try {
    stdout = execFileSync('/bin/bash', [scriptPath], {
      env: {
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        PATH: join(workDir, 'bin'),
        INTERNAL_CRON_SECRET: 'test-secret',
        INTERNAL_CRON_BASE_URL: 'https://fake-test-host',
        SCHEDULE: schedule,
        FAKE_CURL_CONFIG: configPath,
        FAKE_CURL_LOG: logPath,
      },
      encoding: 'utf8',
    })
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string }
    exitCode = e.status ?? 1
    stdout = e.stdout ? e.stdout.toString() : ''
  }

  const calls = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
  return { exitCode, calls, stdout }
}

describe('internal-cron-scheduler.yml dispatch script (category: no-retry runtime behavior)', () => {
  it('A. HTTP 500 results in exactly ONE request to that route', () => {
    const { calls, exitCode } = runDispatch('20 * * * *', { '/api/internal/commissions/finalize-earned': { mode: 'http_500' } })
    expect(calls).toEqual(['/api/internal/commissions/finalize-earned'])
    expect(exitCode).not.toBe(0)
  })

  it('B. HTTP 502 results in exactly ONE request to that route', () => {
    const { calls } = runDispatch('20 * * * *', { '/api/internal/commissions/finalize-earned': { mode: 'http_502' } })
    expect(calls).toEqual(['/api/internal/commissions/finalize-earned'])
  })

  it('C. HTTP 504 results in exactly ONE request to that route', () => {
    const { calls } = runDispatch('20 * * * *', { '/api/internal/commissions/finalize-earned': { mode: 'http_504' } })
    expect(calls).toEqual(['/api/internal/commissions/finalize-earned'])
  })

  it('D. a transport failure results in exactly ONE request to that route', () => {
    const { calls, exitCode } = runDispatch('20 * * * *', { '/api/internal/commissions/finalize-earned': { mode: 'transport_fail' } })
    expect(calls).toEqual(['/api/internal/commissions/finalize-earned'])
    expect(exitCode).not.toBe(0)
  })

  it('E. a timeout-equivalent transport failure results in exactly ONE request to that route', () => {
    const { calls, exitCode } = runDispatch('20 * * * *', { '/api/internal/commissions/finalize-earned': { mode: 'timeout_fail' } })
    expect(calls).toEqual(['/api/internal/commissions/finalize-earned'])
    expect(exitCode).not.toBe(0)
  })

  it('F. no retry/sleep mechanism exists -- curl is invoked at most once per invoke_route call, no sleep, no attempt counter', () => {
    const script = extractRunScript()
    expect(script).not.toMatch(/\bsleep\s/)
    expect(script).not.toMatch(/\bRETRIED\b/)
    expect(script).not.toMatch(/\battempt(s|_count)?\s*[=+]/i)
    // Bash's own ${...} parameter expansion uses braces too, so a naive
    // brace-counter would misfire inside this function -- delimit by the
    // next section's own marker comment instead, which is stable and
    // unambiguous for this specific script's structure.
    const start = script.indexOf('invoke_route() {')
    expect(start, 'could not locate invoke_route() start').toBeGreaterThanOrEqual(0)
    const end = script.indexOf('# --- Invoke every route mapped', start)
    expect(end, 'could not locate the dispatch loop marker after invoke_route()').toBeGreaterThan(start)
    const functionBody = script.slice(start, end)
    // Matches an actual command invocation ("curl -..."), not the word
    // "curl" appearing inside a log message like "(curl exit ...)".
    const curlInvocations = functionBody.match(/\bcurl -/g) ?? []
    expect(curlInvocations).toHaveLength(1)
  })

  it('G. when two routes share a schedule and the first fails, the second is still attempted exactly once', () => {
    const { calls } = runDispatch('0 * * * *', {
      '/api/internal/reviews/process-deadlines': { mode: 'http_500' },
      '/api/internal/affiliate/review-and-approve': { mode: 'success' },
    })
    expect(calls.sort()).toEqual(['/api/internal/affiliate/review-and-approve', '/api/internal/reviews/process-deadlines'].sort())
    expect(calls.filter((c) => c === '/api/internal/reviews/process-deadlines')).toHaveLength(1)
    expect(calls.filter((c) => c === '/api/internal/affiliate/review-and-approve')).toHaveLength(1)
  })

  it('H. if any route fails, the final script result is non-zero', () => {
    const { exitCode } = runDispatch('0 * * * *', {
      '/api/internal/reviews/process-deadlines': { mode: 'http_500' },
      '/api/internal/affiliate/review-and-approve': { mode: 'success' },
    })
    expect(exitCode).not.toBe(0)
  })

  it('I. if all routes succeed, the final script result is zero', () => {
    const { exitCode } = runDispatch('0 * * * *', {
      '/api/internal/reviews/process-deadlines': { mode: 'success' },
      '/api/internal/affiliate/review-and-approve': { mode: 'success' },
    })
    expect(exitCode).toBe(0)
  })

  it('J. a 3xx response is treated as failure and is never retried', () => {
    const { calls, exitCode } = runDispatch('20 * * * *', { '/api/internal/commissions/finalize-earned': { mode: 'http_301' } })
    expect(calls).toEqual(['/api/internal/commissions/finalize-earned'])
    expect(exitCode).not.toBe(0)
  })

  it('K. a 4xx response is treated as failure and is never retried', () => {
    const { calls, exitCode } = runDispatch('20 * * * *', { '/api/internal/commissions/finalize-earned': { mode: 'http_404' } })
    expect(calls).toEqual(['/api/internal/commissions/finalize-earned'])
    expect(exitCode).not.toBe(0)
  })

  it('L. a 5xx response is treated as failure and is never retried (503 case)', () => {
    const { calls, exitCode } = runDispatch('20 * * * *', { '/api/internal/commissions/finalize-earned': { mode: 'http_503' } })
    expect(calls).toEqual(['/api/internal/commissions/finalize-earned'])
    expect(exitCode).not.toBe(0)
  })

  it('a successful 200 with a valid JSON body results in exit 0 and exactly one request', () => {
    const { calls, exitCode } = runDispatch('20 * * * *', { '/api/internal/commissions/finalize-earned': { mode: 'success' } })
    expect(calls).toEqual(['/api/internal/commissions/finalize-earned'])
    expect(exitCode).toBe(0)
  })

  it('a 200 with a non-JSON body is treated as failure, still exactly one request', () => {
    const { calls, exitCode } = runDispatch('20 * * * *', { '/api/internal/commissions/finalize-earned': { mode: 'bad_json' } })
    expect(calls).toEqual(['/api/internal/commissions/finalize-earned'])
    expect(exitCode).not.toBe(0)
  })

  it('an unrecognized schedule is refused before any request is made', () => {
    const { calls, exitCode } = runDispatch('99 99 * * *', {})
    expect(calls).toEqual([])
    expect(exitCode).not.toBe(0)
  })
})
