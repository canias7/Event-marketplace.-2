#!/usr/bin/env bash
# ===================================================================
# Creates the tables in your Neon database and fills in the categories.
# Safe to run more than once - it will not duplicate anything.
#
# Usage:  npm run db:setup
#         npm run db:setup -- --reset     (wipes everything first)
# ===================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

# If DATABASE_URL is not already in the environment, read it from .env
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set."
  echo
  echo "Get it from your Neon dashboard, then either:"
  echo "  - add it to your .env file, or"
  echo "  - set it as an environment variable"
  exit 1
fi

# Show where we are connecting, WITHOUT printing the password.
host="$(echo "$DATABASE_URL" | sed -E 's|.*@([^/]+)/.*|\1|')"
echo "Connecting to: $host"
echo

if [ "${1:-}" = "--reset" ]; then
  echo "WIPING all tables first..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f db/reset.sql
  echo "  done"
fi

echo "Creating tables..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f db/schema.sql
echo "  done"

echo "Adding categories..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f db/seed.sql
echo "  done"

echo
echo "What is in the database now:"
psql "$DATABASE_URL" -q -c "
  select 'categories' as table_name, count(*) from categories
  union all select 'vendors',   count(*) from vendors
  union all select 'admins',    count(*) from admins
  union all select 'customers', count(*) from customers
  union all select 'bookings',  count(*) from bookings
  union all select 'crm_notes', count(*) from crm_notes
  union all select 'payments',  count(*) from payments;"

echo "Database is ready."
