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
# 30001, NOT Foundry's default 30000. *Confirmed live:* a developer's own Foundry was already
# listening on the host's 30000, and `docker compose up` published the container there anyway
# without reporting a conflict - on macOS the host process holds the IPv6 wildcard and simply wins,
# so Docker's binding is shadowed rather than refused. Every request the harness made then went to
# the *personal* server: `bootstrap` tried to install a system and create a world on it, and only
# failed because that server's admin key happened not to be `itest-admin`. Had it matched, the
# specs' `resetWorld()` would have run against a real world.
#
# Defaulting off Foundry's own port means the two can never be confused by accident. Override with
# FOUNDRY_PORT if 30001 is taken too - and set FOUNDRY_URL to match, since that is what the client
# side reads (playwright.config.mjs, bootstrap-world.mjs).
export FOUNDRY_PORT="${FOUNDRY_PORT:-30001}"

# Credentials are only needed when there is nothing to install *from*. A cached release archive
# (itest/.cache) or an existing installation in the data volume is enough on its own, and demanding
# credentials anyway blocks the common case of restarting a container you have already built - the
# exact situation the host-side cache exists to make cheap.
cache_zip="$repo/itest/.cache/foundryvtt-${FOUNDRY_VERSION}.zip"
have_install=""
if docker volume inspect docker_foundry-data >/dev/null 2>&1; then have_install="volume"; fi
if [[ -f "$cache_zip" ]]; then have_install="cache"; fi

if [[ -z "${FOUNDRY_USERNAME:-}" && -z "${FOUNDRY_RELEASE_URL:-}" && -z "$have_install" ]]; then
  echo "error: set FOUNDRY_USERNAME/FOUNDRY_PASSWORD or FOUNDRY_RELEASE_URL." >&2
  echo "Foundry is licensed software; this harness downloads it with your own credentials and" >&2
  echo "never redistributes it. See itest/README.md." >&2
  echo "(A cached release at itest/.cache/foundryvtt-${FOUNDRY_VERSION}.zip, or an existing data" >&2
  echo " volume, would also do - neither was found.)" >&2
  exit 1
fi

if [[ -z "${FOUNDRY_USERNAME:-}" && -z "${FOUNDRY_RELEASE_URL:-}" ]]; then
  echo "No credentials set; using the existing ${have_install}."
fi

# The fixtures are a bind mount; an empty directory here means every track resolves to a 404 and
# every spec fails as silence, so fail early and legibly instead.
if [[ ! -f "$repo/itest/fixtures/out/tone-alpha.wav" ]]; then
  echo "error: fixtures missing - run 'npm run fixtures' in itest/ first." >&2
  exit 1
fi

# Which tree the container mounts as the module. Default is the working tree - the fast local loop.
#
# ITEST_AGAINST_DIST=1 builds and mounts `dist/` instead: the minified bundle that actually ships.
# The release workflow sets it, because a gate that certifies the source while the zip carries a
# bundle is a gate for code no user runs. Build here rather than making the caller remember to,
# so that a stale dist/ can never be silently certified as a fresh one.
if [[ -n "${ITEST_AGAINST_DIST:-}" ]]; then
  echo "Building dist/ (ITEST_AGAINST_DIST is set); the suite will run against the shipped bundle."
  (cd "$repo" && npm run build)
  export MODULE_MOUNT="../../dist"
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
