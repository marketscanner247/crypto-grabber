#!/usr/bin/env bash
# One alert check. The crypto-grabber timer runs this every 5 minutes as the "cg" user.
# It first pulls any files you uploaded to GitHub, so the server always runs your latest version.
set -uo pipefail
DIR=/opt/crypto-grabber
cd "$DIR" || exit 1
# one check at a time: a manual run (cg brief, cg test...) waits for a running timer check to finish
exec 9>"${HOME:-/var/lib/cg}/run.lock"
flock -w 600 9 || { echo "another check is still running"; exit 0; }
before=$(sha1sum bot/package.json 2>/dev/null | cut -c1-40)
timeout 60 git pull -q --ff-only 2>/dev/null || echo "could not update from GitHub, using the current copy"
after=$(sha1sum bot/package.json 2>/dev/null | cut -c1-40)
if [ "$before" != "$after" ] || [ ! -d bot/node_modules/playwright ]; then
  echo "dependencies changed, reinstalling"
  (cd bot && npm install --no-audit --no-fund --silent && npx playwright install chromium) || true
fi
exec node bot/alert.js
