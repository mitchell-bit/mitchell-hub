#!/bin/zsh
# Rebuild data.enc from the screenings bot and push it. Called at the end of every bot run (nyc-screenings/bin/run.sh).
export PATH="/Users/mitchell/.nvm/versions/node/v24.13.1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "${0:A:h}/.." || exit 1
node bin/build.mjs "$@" || exit 1
git add data.enc
# Only the encrypted blob and app shell may ever be committed by this script.
if git diff --cached --name-only | grep -v -x 'data.enc' | grep -q .; then
  echo "publish: refusing, unexpected staged files"; exit 1
fi
git diff --cached --quiet && { echo "publish: nothing to push"; exit 0; }
git commit -q -m "data: $(date '+%F %H:%M')" && git push -q origin main && echo "publish: pushed"
