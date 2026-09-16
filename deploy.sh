#!/bin/sh
# epok — publish a byte-identical copy to deploy/public.
#
# The arrangement is the one in ../Boli laga bc/deploy: a separate git repo,
# gitignored by the parent, holding nothing but the files the browser needs.
# It is a COPY, never a symlink and never the source itself — so what is
# public is auditable as a fixed set, and nothing in the project folder can
# leak by being one directory too high.
#
# epok's deploy carries no Worker and no password, unlike Bob the Builder's.
# There is nothing to protect on the server: what is published is the code,
# and the log never leaves the browser it was typed into.
#
#   ./deploy.sh          copy, verify byte-identity, report
#   ./deploy.sh --push   the same, then `npx wrangler deploy` from deploy/
#
# This script never commits and never pushes on its own.

set -e
cd "$(dirname "$0")"

SRC=.
OUT=deploy/public

# Exactly what the browser loads. Kept in step with service-worker.js's SHELL
# list by tools/verify.py, which fails if the two ever disagree — a file
# missing from either one is a view that is blank offline.
FILES="index.html manifest.webmanifest service-worker.js"
DIRS="css js icons"

rm -rf "$OUT"
mkdir -p "$OUT"

for f in $FILES; do
  cp "$SRC/$f" "$OUT/$f"
done
for d in $DIRS; do
  cp -R "$SRC/$d" "$OUT/$d"
done

# Byte-identity is the claim, so it gets checked rather than assumed.
fail=0
count=0
for f in $(cd "$OUT" && find . -type f | sort); do
  if cmp -s "$OUT/$f" "$SRC/$f"; then
    count=$((count + 1))
  else
    echo "DIFFERS: $f"
    fail=1
  fi
done

# Nothing from the project folder that is not part of the app.
for stray in PLAN-epok.md CONTRACTS.md STATUS.md serve.sh deploy.sh tools; do
  if [ -e "$OUT/$stray" ]; then
    echo "LEAKED INTO THE DEPLOY: $stray"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "deploy: refused, the copy is not byte-identical to the source"
  exit 1
fi

echo "deploy: $count files, byte-identical to the source"

if [ ! -d deploy/.git ]; then
  echo "deploy: deploy/ is not a git repo yet. To make it one:"
  echo "    git -C deploy init && git -C deploy add -A"
  echo "    git -C deploy remote add origin <your remote>"
fi

if [ "$1" = "--push" ]; then
  cd deploy && exec npx wrangler deploy
fi

echo "deploy: to publish, run  cd deploy && npx wrangler deploy"
