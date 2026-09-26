#!/bin/bash
# Test-only fake `curl`, used exclusively by
# scheduler-runtime.test.ts to exercise the REAL dispatch script
# extracted from internal-cron-scheduler.yml without any network access,
# any real endpoint, or any secret. Never referenced by the workflow
# itself and never invoked outside this test's own isolated PATH.
#
# Configured via two env vars:
#   FAKE_CURL_CONFIG -- path to a JSON file mapping a route path (e.g.
#                       "/api/internal/foo") to { "mode": "..." }.
#   FAKE_CURL_LOG     -- path to a file this script appends one line to
#                       per invocation (the route path), so the test can
#                       assert exactly how many times -- and for which
#                       route -- curl was "called".
#
# Modes: success | http_500 | http_502 | http_504 | http_503 | http_401 |
# http_404 | http_301 | transport_fail | timeout_fail | bad_json.
# Unknown/unset route defaults to "success".
set -euo pipefail

url=""
body_file=""
prev=""
for arg in "$@"; do
  if [ "${prev}" = "-o" ]; then body_file="${arg}"; fi
  prev="${arg}"
done
url="${*: -1}"

route="${url#https://fake-test-host}"

echo "${route}" >> "${FAKE_CURL_LOG}"

mode=$(jq -r --arg r "${route}" '.[$r].mode // "success"' "${FAKE_CURL_CONFIG}")

case "${mode}" in
  transport_fail)
    exit 7 # curl: couldn't connect
    ;;
  timeout_fail)
    exit 28 # curl: operation timeout
    ;;
  http_500) echo '{}' > "${body_file}"; printf '500'; exit 0 ;;
  http_502) echo '{}' > "${body_file}"; printf '502'; exit 0 ;;
  http_504) echo '{}' > "${body_file}"; printf '504'; exit 0 ;;
  http_503) echo '{}' > "${body_file}"; printf '503'; exit 0 ;;
  http_401) echo '{}' > "${body_file}"; printf '401'; exit 0 ;;
  http_404) echo '{}' > "${body_file}"; printf '404'; exit 0 ;;
  http_301) echo '{}' > "${body_file}"; printf '301'; exit 0 ;;
  bad_json) echo 'not json' > "${body_file}"; printf '200'; exit 0 ;;
  success|*)
    echo '{"ok":true}' > "${body_file}"
    printf '200'
    exit 0
    ;;
esac
