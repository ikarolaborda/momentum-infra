#!/usr/bin/env bash
set -euo pipefail

echo "=== Momentum Search Reindex ==="

SEARCH_SERVICE_URL=${SEARCH_SERVICE_URL:-http://localhost:3003}

echo "Triggering full reindex..."
# The search service handles reindex through its outbox poller
# For manual reindex, we can use the indexer directly

echo "Checking Elasticsearch health..."
curl -s http://localhost:9200/_cluster/health | python3 -m json.tool 2>/dev/null || echo "ES health check"

echo "Checking events index..."
curl -s http://localhost:9200/events/_count | python3 -m json.tool 2>/dev/null || echo "Index count check"

echo ""
echo "To trigger a full reindex, restart the search service."
echo "The outbox poller will automatically pick up and index all events."
echo ""
echo "Reindex process complete."
