#!/usr/bin/env bash
# ===================================================================
# Runs the whole test suite against a REAL Postgres server instead of
# the built-in local database.
#
# Why bother: Neon is a real Postgres server, and the app reaches it
# with a different driver over a network connection. Testing only
# against the built-in database leaves that whole path unproven.
#
# This sets up a throwaway Postgres on this machine and points the
# tests at it. Needs root, because it installs Postgres if missing.
#
# Usage:  npm run test:server
# ===================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME=eventvendora_test
DB_USER=marketplace_test
DB_PASS=localtestonly

if ! ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1; then
  echo "Installing Postgres (this only happens once)..."
  apt-get install -y -q postgresql >/dev/null 2>&1 || {
    apt-get update -q >/dev/null 2>&1
    apt-get install -y -q postgresql >/dev/null 2>&1
  }
fi

VERSION="$(ls -1 /usr/lib/postgresql | sort -n | tail -1)"
export PATH="/usr/lib/postgresql/$VERSION/bin:$PATH"

if ! pg_lsclusters 2>/dev/null | grep -q online; then
  echo "Starting Postgres..."
  pg_ctlcluster "$VERSION" main start
  for _ in $(seq 1 30); do
    su postgres -c "psql -tAc 'select 1'" >/dev/null 2>&1 && break
    sleep 1
  done
fi

echo "Creating a clean test database..."
su postgres -c "psql -q -c \"drop database if exists $DB_NAME;\"" >/dev/null
su postgres -c "psql -tAc \"select 1 from pg_roles where rolname='$DB_USER'\"" | grep -q 1 \
  || su postgres -c "psql -q -c \"create user $DB_USER with password '$DB_PASS';\"" >/dev/null
su postgres -c "psql -q -c \"create database $DB_NAME owner $DB_USER;\"" >/dev/null

echo
TEST_DATABASE_URL="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME" exec bash test/e2e.sh
