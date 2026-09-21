/**
 * Validates a client-suppliable post-auth redirect destination (e.g. the
 * `redirectTo` query param on /login and /verify) before it is ever
 * handed to client-side navigation. Only an app-relative path is ever
 * allowed -- a caller must supply their own default destination for
 * anything else, including a missing/empty value.
 *
 * Deliberately minimal and conservative rather than attempting to parse
 * or "fix" a destination: reject anything that isn't unambiguously an
 * internal path. Rejection is fail-closed -- an unsafe value is never
 * transformed/stripped/sanitized into something else, only replaced
 * wholesale with the caller's fallback.
 *
 *   Allowed:  "/dashboard", "/en/dashboard", "/zu/listings/123", "/"
 *   Rejected: "https://evil.example", "http://evil.example",
 *             "//evil.example" (protocol-relative), "/\evil.example"
 *             (backslash-normalization bypass), "javascript:alert(1)",
 *             "data:text/html,...", "evil.example", "evil.example/path",
 *             "/\t/evil.example" (tab/LF/CR-normalization bypass, below)
 *
 * `URLSearchParams.get()` already percent-decodes its value before this
 * function ever sees it, so a caller does not need to decode anything
 * first -- e.g. "%2F%2Fevil.example" arrives here as "//evil.example"
 * and is rejected by the same check as the literal form.
 *
 * The WHATWG URL Living Standard requires every conforming URL parser --
 * every browser's own, and by extension the History API navigation this
 * value is ultimately handed to via router.push() -- to strip ASCII tab
 * (U+0009), line feed (U+000A), and carriage return (U+000D) characters
 * from a URL *anywhere in the string* before further parsing. That means
 * a value such as "/\t/evil.example" starts with a single "/" and is
 * neither "//..." nor "/\\..." as *written*, but collapses to the
 * protocol-relative "//evil.example" once actually parsed for
 * navigation -- after this function's own prefix checks would already
 * have let it through. Reject any value containing one of these three
 * characters, anywhere in the string, before doing anything else.
 */
export function getSafeRedirectPath(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  if (/[\t\n\r]/.test(value)) return fallback
  if (!value.startsWith('/')) return fallback
  // "//evil.example" (protocol-relative) and "/\evil.example" (a
  // backslash right after the leading slash, which some browsers
  // normalize the same as a second forward slash) both resolve to an
  // external origin despite starting with a single "/" character.
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback
  return value
}
