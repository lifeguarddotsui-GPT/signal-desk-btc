#!/usr/bin/env bash
set -euo pipefail
# New, disposable loopback cluster only. No app or production credentials.
root="$(mktemp -d /tmp/bluewater-release-tests.XXXXXX)"
port=5719
user="$(id -un)"
mkdir "$root/socket"
initdb -D "$root/data" -A trust --no-locale >/dev/null
pg_ctl -D "$root/data" -l "$root/postgres.log" \
  -o "-h 127.0.0.1 -k $root/socket -p $port" start >/dev/null
trap 'pg_ctl -D "$root/data" stop -m fast >/dev/null' EXIT
trap 'exit 130' INT TERM
for db in waterx_reference_test bluewater_agent_test waterx_timed_test; do
  createdb -h "$root/socket" -p "$port" -U "$user" "$db"
done
export DATABASE_URL="postgresql://$user@127.0.0.1:$port/waterx_timed_test"
export WATERX_REFERENCE_CONFIRMATION_TEST_DATABASE_URL="postgresql://$user@127.0.0.1:$port/waterx_reference_test"
export AGENT_TEST_DATABASE_URL="postgresql://$user@127.0.0.1:$port/bluewater_agent_test"
export RUN_TIMED_POSTGRES_TESTS=1
if [ "$#" -gt 0 ]; then
  node --import tsx --test --test-concurrency=1 "$@"
else
  mapfile -t tests < <(find scripts client/src -maxdepth 1 -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)
  node --import tsx --test --test-concurrency=1 "${tests[@]}"
fi
