#!/usr/bin/env bash
set -euo pipefail

build_dir="${1:-shared/zktls/extension-sdk/build}"
strict="${2:-}"
if [ "$build_dir" = "--strict" ]; then
  build_dir="shared/zktls/extension-sdk/build"
  strict="--strict"
fi

if [ ! -d "$build_dir" ]; then
  echo "SDK fork build directory missing: $build_dir" >&2
  exit 2
fi
# Hosted Reclaim services and the third-party geo-IP lookups the fork removed.
forbidden='reclaimprotocol\.org|api\.country\.is|ipwho\.is|ipapi\.co\b'

if [ -n "$strict" ] && [ "$strict" != "--strict" ]; then
  echo "Usage: $0 [build-dir] [--strict]" >&2
  exit 2
fi

if ! runtime_file=$(find "$build_dir" -type f \( -name '*.js' -o -name '*.html' \) -print -quit); then
  echo "Cannot inspect SDK fork runtime artifacts: $build_dir" >&2
  exit 2
fi
if [ -z "$runtime_file" ]; then
  echo "SDK fork runtime artifacts missing: $build_dir" >&2
  exit 2
fi

if matches=$(rg -l --text --glob '*.js' --glob '*.html' "$forbidden" "$build_dir"); then
  matches=$(printf '%s\n' "$matches" | LC_ALL=C sort)
  mapfile -t files <<< "$matches"
else
  status=$?
  if [ "$status" -ne 1 ]; then
    echo "SDK fork domain scan failed (rg exit $status)" >&2
    exit "$status"
  fi
  files=()
fi
if [ "${#files[@]}" -eq 0 ]; then
  echo "No forbidden hosts in SDK fork runtime bundles."
  exit 0
fi

echo "Forbidden hosts in SDK fork runtime bundles:"
for file in "${files[@]}"; do
  echo "$file"
  rg -o --no-filename "[[:alnum:].-]*(${forbidden})" "$file" | LC_ALL=C sort | uniq -c
done

if [ "$strict" = "--strict" ]; then
  exit 1
fi
