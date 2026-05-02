#!/bin/bash
# Oro Database Seed Script
# Seeds the production database with initial data (markets, outcomes, etc.)
#
# Usage:
#   ./seed/run-seed.sh                     # Uses env vars from current shell
#   DB_HOST=localhost DB_NAME=oro_db ./seed/run-seed.sh   # Override
#
# For K8s:
#   kubectl exec -it <backend-pod> -- /app/seed/run-seed.sh

set -e

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USERNAME="${DB_USERNAME:-postgres}"
DB_NAME="${DB_NAME:-oro_db}"

echo "🌱 Seeding database: $DB_NAME @ $DB_HOST:$DB_PORT"
echo "   User: $DB_USERNAME"
echo ""

# Disable FK constraints during seed to handle circular refs
PGPASSWORD="${DB_PASSWORD}" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d "$DB_NAME" \
  -c "SET session_replication_role = 'replica';" \
  -f /app/seed/seed.sql \
  -c "SET session_replication_role = 'origin';"

echo ""
echo "Seed complete!"
