#!/usr/bin/env bash
# Apply a 30-day expiration lifecycle rule to chat attachment objects in
# the `dodo-workspaces` R2 bucket. Run once per environment (dev/prod) to
# provision auto-cleanup.
#
# Attachments are stored under the `attachments/` prefix by
# src/attachments.ts. Workspace files (project code) live elsewhere in the
# bucket and are untouched by this rule.
#
# Usage:
#   ./scripts/setup-attachment-lifecycle.sh
#
# Requires: wrangler logged in with R2 permissions for the target account.

set -euo pipefail

BUCKET_NAME="${BUCKET_NAME:-dodo-workspaces}"
RULE_ID="attachments-30d-expire"
PREFIX="attachments/"
EXPIRE_DAYS=30

echo "Applying lifecycle rule to R2 bucket: $BUCKET_NAME"
echo "  Rule: $RULE_ID"
echo "  Prefix: $PREFIX"
echo "  Expire after: $EXPIRE_DAYS days"

# Positional args: bucket, name, prefix
npx wrangler r2 bucket lifecycle add "$BUCKET_NAME" "$RULE_ID" "$PREFIX" \
  --expire-days "$EXPIRE_DAYS" \
  --force

echo
echo "Current rules on $BUCKET_NAME:"
npx wrangler r2 bucket lifecycle list "$BUCKET_NAME"
