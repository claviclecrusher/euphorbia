#!/bin/bash
# Build all installers for the version in package.json and upload them to a
# GitHub release, including the latest*.yml files the auto-updater reads.
#
#   npm run release              build and publish
#   npm run release -- --draft   upload as a draft (invisible to the updater)
#   npm run release -- --build-only
set -euo pipefail
cd "$(dirname "$0")/.."

mode=publish
for arg in "$@"; do
  case "$arg" in
    --draft) mode=draft ;;
    --build-only) mode=build ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

version=$(node -p "require('./package.json').version")
tag="v$version"
echo "==> building $tag"

rm -rf dist
npx electron-builder --linux AppImage deb --publish never

# NSIS needs wine, so the Windows build runs in the electron-builder container.
cache="${XDG_CACHE_HOME:-$HOME/.cache}/euphorbia-builder"
mkdir -p "$cache"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/home \
  -v "$cache":/tmp/home -v "$PWD":"$PWD" -w "$PWD" \
  electronuserland/builder:wine \
  npx electron-builder --win nsis portable --publish never

assets=(
  "dist/euphorbia-setup-$version.exe"
  "dist/euphorbia-setup-$version.exe.blockmap"
  "dist/euphorbia-portable-$version.exe"
  "dist/euphorbia-$version.AppImage"
  "dist/euphorbia_${version}_amd64.deb"
  "dist/latest.yml"
  "dist/latest-linux.yml"
)
for f in "${assets[@]}"; do
  [ -f "$f" ] || { echo "missing build output: $f" >&2; exit 1; }
done

if [ "$mode" = build ]; then
  echo "==> built (not uploaded):"; printf '    %s\n' "${assets[@]}"
  exit 0
fi

flags=(--title "$tag" --generate-notes)
[ "$mode" = draft ] && flags+=(--draft)
gh release create "$tag" "${assets[@]}" "${flags[@]}"
echo "==> released $tag ($mode)"
