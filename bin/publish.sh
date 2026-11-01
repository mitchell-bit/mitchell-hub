#!/bin/zsh
# Rebuild data.enc from the screenings bot and push it. Called at the end of every bot run (nyc-screenings/bin/run.sh).
export PATH="/Users/mitchell/.nvm/versions/node/v24.13.1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "${0:A:h}/.." || exit 1
node bin/build.mjs "$@" || exit 1
git add -A data.enc t
# Only the encrypted blob and app shell may ever be committed by this script.
if git diff --cached --name-only | grep -v -x 'data.enc' | grep -v -E '^t/[0-9a-f]+\.enc$' | grep -q .; then
  echo "publish: refusing, unexpected staged files"; exit 1
fi
git diff --cached --quiet || git commit -q -m "data: $(date '+%F %H:%M')"
# Push whenever local is ahead, so a commit left behind by a failed push goes out next run.
[ -n "$(git rev-list origin/main..HEAD 2>/dev/null)" ] || { echo "publish: nothing to push"; exit 0; }
git push -q origin main && echo "publish: pushed"
