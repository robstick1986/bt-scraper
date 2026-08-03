#!/bin/sh
# The official Playwright image bundles browsers under a version-specific
# folder; find the actual chrome binary at container start rather than
# hardcoding a path that breaks on image updates.
set -e
export CHROMIUM_PATH="$(find /ms-playwright -type f -name chrome -path '*chrome-linux*' | head -n1)"
if [ -z "$CHROMIUM_PATH" ]; then
  echo "ERROR: could not locate bundled chromium binary under /ms-playwright" >&2
  exit 1
fi
echo "Using chromium at: $CHROMIUM_PATH"
exec node server.js
