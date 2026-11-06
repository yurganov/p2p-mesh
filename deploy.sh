#!/bin/zsh
# Собирает страницу и выкладывает папку public/ в ветку gh-pages репозитория на GitHub.
set -euo pipefail
cd "$(dirname "$0")"
npm run -s build
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
T=$(mktemp -d)
cp -R public/. "$T/"
touch "$T/.nojekyll"
git -C "$T" init -q -b gh-pages
git -C "$T" add -A
git -C "$T" -c user.name=alexey -c user.email=alexey@yurganov.com commit -qm "Выкладка $(git rev-parse --short HEAD)"
git -C "$T" push -qf "https://github.com/$REPO.git" gh-pages
rm -rf "$T"
echo "Выложено: https://$(echo $REPO | cut -d/ -f1 | tr 'A-Z' 'a-z').github.io/$(echo $REPO | cut -d/ -f2)/"
