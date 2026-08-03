#!/usr/bin/env bash
#
# Start the pinned Foundry container and wait until it is genuinely serving.
#
# The version comes from module.json's `compatibility.verified` - the manifest is the source of
# truth for what this module claims to support, and the integration suite must certify that exact
# string rather than a number maintained in a second place.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

FOUNDRY_VERSION="${FOUNDRY_VERSION:-$(node -p "require('$repo/module.json').compatibility.verified")}"
export FOUNDRY_VERSION
export FOUNDRY_PORT="${FOUNDRY_PORT:-30000}"

if [[ -z "${FOUNDRY_USERNAME:-}" && -z "${FOUNDRY_RELEASE_URL:-}" ]]; then
  echo "error: set FOUNDRY_USERNAME/FOUNDRY_PASSWORD or FOUNDRY_RELEASE_URL." >&2
  echo "Foundry is licensed software; this harness downloads it with your own credentials and" >&2
  echo "never redistributes it. See itest/README.md." >&2
  exit 1
fi

# The fixtures are a bind mount; an empty directory here means every track resolves to a 404 and
# every spec fails as silence, so fail early and legibly instead.
if [[ ! -f "$repo/itest/fixtures/out/tone-alpha.wav" ]]; then
  echo "error: fixtures missing - run 'npm run fixtures' in itest/ first." >&2
  exit 1
fi

compose="$repo/itest/docker/docker-compose.yml"

echo "Starting Foundry ${FOUNDRY_VERSION} on port ${FOUNDRY_PORT}..."

# `--wait` reports only "container exited (1)" when startup fails, which is useless: every real
# cause (missing credentials, a licence problem, the mount-ownership EACCES) is a legible line in
# the container's own log. Surfacing it here saves the next person the hunt.
if ! docker compose -f "$compose" up -d --wait; then
  echo >&2
  echo "error: Foundry failed to start. Container log follows:" >&2
  echo >&2
  docker compose -f "$compose" logs --no-color --tail 40 >&2
  exit 1
fi

echo "Foundry ${FOUNDRY_VERSION} is up at http://localhost:${FOUNDRY_PORT}"
