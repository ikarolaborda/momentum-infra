# Momentum -- Search Architecture

## Overview

The search subsystem provides full-text search, autocomplete, and faceted filtering for events, venues, and artists. It is built on Elasticsearch 8 with Portuguese-aware analyzers and maintained via an event-driven indexing pipeline.

## Elasticsearch Index Mapping

### Events Index

```json
{
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1,
    "analysis": {
      "analyzer": {
        "momentum_portuguese": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": [
            "lowercase",
            "asciifolding",
            "portuguese_stop",
            "portuguese_stemmer"
          ]
        },
        "momentum_autocomplete": {
          "type": "custom",
          "tokenizer": "momentum_edge_ngram",
          "filter": [
            "lowercase",
            "asciifolding"
          ]
        },
        "momentum_autocomplete_search": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": [
            "lowercase",
            "asciifolding"
          ]
        }
      },
      "tokenizer": {
        "momentum_edge_ngram": {
          "type": "edge_ngram",
          "min_gram": 2,
          "max_gram": 15,
          "token_chars": ["letter", "digit"]
        }
      },
      "filter": {
        "portuguese_stop": {
          "type": "stop",
          "stopwords": "_portuguese_"
        },
        "portuguese_stemmer": {
          "type": "stemmer",
          "language": "portuguese"
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "id": { "type": "keyword" },
      "name": {
        "type": "text",
        "analyzer": "momentum_portuguese",
        "fields": {
          "exact": { "type": "keyword" },
          "suggest": {
            "type": "text",
            "analyzer": "momentum_autocomplete",
            "search_analyzer": "momentum_autocomplete_search"
          }
        }
      },
      "description": {
        "type": "text",
        "analyzer": "momentum_portuguese"
      },
      "venue": {
        "properties": {
          "id": { "type": "keyword" },
          "name": {
            "type": "text",
            "analyzer": "momentum_portuguese",
            "fields": {
              "suggest": {
                "type": "text",
                "analyzer": "momentum_autocomplete",
                "search_analyzer": "momentum_autocomplete_search"
              }
            }
          },
          "city": { "type": "keyword" },
          "state": { "type": "keyword" },
          "location": { "type": "geo_point" }
        }
      },
      "artists": {
        "type": "nested",
        "properties": {
          "id": { "type": "keyword" },
          "name": {
            "type": "text",
            "analyzer": "momentum_portuguese",
            "fields": {
              "suggest": {
                "type": "text",
                "analyzer": "momentum_autocomplete",
                "search_analyzer": "momentum_autocomplete_search"
              }
            }
          },
          "genre": { "type": "keyword" }
        }
      },
      "categories": { "type": "keyword" },
      "tags": { "type": "keyword" },
      "date": { "type": "date" },
      "on_sale_date": { "type": "date" },
      "price_range": {
        "properties": {
          "min": { "type": "float" },
          "max": { "type": "float" },
          "currency": { "type": "keyword" }
        }
      },
      "available_tickets": { "type": "integer" },
      "total_tickets": { "type": "integer" },
      "status": { "type": "keyword" },
      "is_featured": { "type": "boolean" },
      "created_at": { "type": "date" },
      "updated_at": { "type": "date" }
    }
  }
}
```

### Analyzer Behavior

| Input                   | After `momentum_portuguese`           | After `momentum_autocomplete` |
|-------------------------|---------------------------------------|-------------------------------|
| "Apresentacao Musical"  | ["apresent", "music"]                 | ["ap", "apr", "apre", ..., "apresentacao", "mu", "mus", ..., "musical"] |
| "Sao Paulo"             | ["sao", "paul"]                       | ["sa", "sao", "pa", "pau", "paul", "paulo"] |
| "Teatro de Danca"       | ["teatr", "danc"] (stop: "de")        | ["te", "tea", ..., "teatro", "de", "da", "dan", ..., "danca"] |

- `asciifolding` normalizes "Sao" to "Sao", "danca" to "danca" (removes diacritics).
- `portuguese_stemmer` reduces words to stems: "apresentacao" -> "apresent".
- `portuguese_stop` removes common function words: "de", "do", "da", "em", "para".

## Indexing Pipeline

### Architecture

```
┌────────────────┐    ┌──────────┐    ┌───────────────┐    ┌───────────────────┐
│  Event Service │    │ Outbox   │    │    Kafka      │    │  Search Service   │
│                │    │ Table    │    │               │    │  (Indexer)        │
│  CREATE/UPDATE ├───►│          ├───►│ events.created├───►│                   │
│  event         │ TX │ Poller   │    │ events.updated│    │  Transform &      │
│                │    │ publishes│    │               │    │  Index to ES      │
└────────────────┘    └──────────┘    └───────────────┘    └───────┬───────────┘
                                                                   │
                                                          ┌────────▼──────────┐
                                                          │  Elasticsearch    │
                                                          │  events index     │
                                                          └───────────────────┘
```

### Flow Steps

1. **Event Service** creates or updates an event in PostgreSQL. Within the same transaction, a row is inserted into the `outbox` table.
2. **Outbox Poller** reads unpublished outbox rows every 500ms and publishes them to the appropriate Kafka topic (`events.created`, `events.updated`, `events.cancelled`).
3. **Search Service** (Kafka consumer group `search-indexer`) consumes the event. It:
   - Enriches the payload with denormalized venue and artist data (fetched from the event service or a local read-through cache).
   - Transforms the data into the Elasticsearch document format.
   - Indexes the document using the Elasticsearch bulk API (batched every 500ms or 100 documents, whichever comes first).
4. **Elasticsearch** processes the bulk request and makes the document searchable after the refresh interval (default 1s).

### Consumer Configuration

```typescript
@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'KAFKA_SERVICE',
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId: 'search-indexer',
            brokers: ['kafka-1:9092', 'kafka-2:9092', 'kafka-3:9092'],
          },
          consumer: {
            groupId: 'search-indexer',
            sessionTimeout: 30000,
            heartbeatInterval: 10000,
            maxWaitTimeInMs: 500,
          },
        },
      },
    ]),
  ],
})
export class SearchIndexerModule {}
```

### Error Handling

- **Transient failures** (Elasticsearch timeout, network error): The consumer retries with exponential backoff (1s, 2s, 4s, max 30s).
- **Permanent failures** (malformed document, mapping conflict): The message is published to a dead letter topic (`events.created.dlq`) for manual inspection.
- **Consumer lag alert**: If consumer group lag exceeds 1,000 messages or 5 seconds of lag, an alert fires.

## Query Construction

### Full-Text Search with Fuzzy Matching

```typescript
async searchEvents(query: string, filters: SearchFilters): Promise<SearchResult> {
  const body: any = {
    query: {
      bool: {
        must: [],
        filter: [],
      },
    },
    sort: [],
    size: filters.limit || 20,
    from: filters.offset || 0,
  };

  if (query) {
    body.query.bool.must.push({
      multi_match: {
        query: query,
        fields: [
          'name^3',
          'name.suggest^2',
          'artists.name^2',
          'artists.name.suggest',
          'venue.name',
          'venue.name.suggest',
          'description',
        ],
        type: 'best_fields',
        fuzziness: 'AUTO',
        prefix_length: 1,
        operator: 'or',
        minimum_should_match: '75%',
      },
    });
  }

  // Category filter
  if (filters.category) {
    body.query.bool.filter.push({
      term: { categories: filters.category },
    });
  }

  // Date range filter
  if (filters.dateFrom || filters.dateTo) {
    const range: any = {};
    if (filters.dateFrom) range.gte = filters.dateFrom;
    if (filters.dateTo) range.lte = filters.dateTo;
    body.query.bool.filter.push({ range: { date: range } });
  }

  // Price range filter
  if (filters.priceMin !== undefined || filters.priceMax !== undefined) {
    const range: any = {};
    if (filters.priceMin !== undefined) range.gte = filters.priceMin;
    if (filters.priceMax !== undefined) range.lte = filters.priceMax;
    body.query.bool.filter.push({ range: { 'price_range.min': range } });
  }

  // City filter
  if (filters.city) {
    body.query.bool.filter.push({
      term: { 'venue.city': filters.city },
    });
  }

  // Only show active events with future dates
  body.query.bool.filter.push(
    { term: { status: 'active' } },
    { range: { date: { gte: 'now' } } },
  );

  // Sorting
  if (filters.sort === 'date') {
    body.sort.push({ date: 'asc' });
  } else if (filters.sort === 'price') {
    body.sort.push({ 'price_range.min': 'asc' });
  } else {
    body.sort.push('_score', { date: 'asc' });
  }

  const result = await this.esClient.search({
    index: 'events',
    body,
  });

  return {
    hits: result.hits.hits.map(hit => ({
      ...hit._source,
      score: hit._score,
    })),
    total: (result.hits.total as any).value,
    took: result.took,
  };
}
```

### Autocomplete Query

```typescript
async autocomplete(prefix: string): Promise<AutocompleteResult[]> {
  const result = await this.esClient.search({
    index: 'events',
    body: {
      query: {
        bool: {
          should: [
            {
              multi_match: {
                query: prefix,
                fields: [
                  'name.suggest^3',
                  'artists.name.suggest^2',
                  'venue.name.suggest',
                ],
                type: 'best_fields',
              },
            },
          ],
          filter: [
            { term: { status: 'active' } },
            { range: { date: { gte: 'now' } } },
          ],
        },
      },
      _source: ['id', 'name', 'date', 'venue.name', 'artists.name'],
      size: 8,
    },
  });

  return result.hits.hits.map(hit => ({
    id: hit._source.id,
    name: hit._source.name,
    venue: hit._source.venue?.name,
    date: hit._source.date,
    type: 'event',
  }));
}
```

### Query Behavior Examples

| User Input     | Fuzzy Match | Stems Matched       | Result |
|----------------|-------------|----------------------|--------|
| "coldpaly"     | Yes (edit distance 1) | N/A (name match) | "Coldplay" events |
| "apresentacoes"| No (exact stem) | "apresent" | Events with "Apresentacao" in name |
| "sao paul"     | No (prefix match via suggest) | "sao", "paul" | Venues in "Sao Paulo" |
| "rok"          | Yes (edit distance 1) | N/A | Events tagged "rock" |

## Reindex Procedure

### When to Reindex

- Mapping changes (new fields, analyzer changes).
- Index corruption.
- Bulk data migration.
- Analyzer configuration update.

### Zero-Downtime Reindex Process

```
Step 1: Create new index with updated mapping
        Index name: events_v2 (versioned)

Step 2: Create alias pointing to current index
        events_read → events_v1
        events_write → events_v1

Step 3: Switch write alias to new index
        events_write → events_v2

Step 4: Reindex from old to new
        POST _reindex { source: events_v1, dest: events_v2 }

Step 5: Verify document counts match

Step 6: Switch read alias to new index
        events_read → events_v2

Step 7: Delete old index after confirmation period (24h)
```

### Reindex Script

```bash
#!/bin/bash
set -euo pipefail

OLD_INDEX="events_v1"
NEW_INDEX="events_v2"
ALIAS="events"
ES_URL="${ELASTICSEARCH_URL:-http://localhost:9200}"

echo "Creating new index ${NEW_INDEX}..."
curl -s -XPUT "${ES_URL}/${NEW_INDEX}" \
  -H 'Content-Type: application/json' \
  -d @mappings/events.json

echo "Starting reindex from ${OLD_INDEX} to ${NEW_INDEX}..."
TASK_ID=$(curl -s -XPOST "${ES_URL}/_reindex?wait_for_completion=false" \
  -H 'Content-Type: application/json' \
  -d "{\"source\":{\"index\":\"${OLD_INDEX}\"},\"dest\":{\"index\":\"${NEW_INDEX}\"}}" \
  | jq -r '.task')

echo "Reindex task: ${TASK_ID}"
echo "Monitoring progress..."

while true; do
  STATUS=$(curl -s "${ES_URL}/_tasks/${TASK_ID}")
  COMPLETED=$(echo "$STATUS" | jq -r '.completed')
  if [ "$COMPLETED" = "true" ]; then
    echo "Reindex complete."
    break
  fi
  CREATED=$(echo "$STATUS" | jq -r '.task.status.created')
  TOTAL=$(echo "$STATUS" | jq -r '.task.status.total')
  echo "Progress: ${CREATED}/${TOTAL}"
  sleep 5
done

# Verify counts
OLD_COUNT=$(curl -s "${ES_URL}/${OLD_INDEX}/_count" | jq '.count')
NEW_COUNT=$(curl -s "${ES_URL}/${NEW_INDEX}/_count" | jq '.count')
echo "Old index: ${OLD_COUNT} docs, New index: ${NEW_COUNT} docs"

if [ "$OLD_COUNT" != "$NEW_COUNT" ]; then
  echo "WARNING: Document counts do not match!"
  exit 1
fi

# Swap alias
echo "Swapping alias ${ALIAS} from ${OLD_INDEX} to ${NEW_INDEX}..."
curl -s -XPOST "${ES_URL}/_aliases" \
  -H 'Content-Type: application/json' \
  -d "{
    \"actions\": [
      {\"remove\": {\"index\": \"${OLD_INDEX}\", \"alias\": \"${ALIAS}\"}},
      {\"add\": {\"index\": \"${NEW_INDEX}\", \"alias\": \"${ALIAS}\"}}
    ]
  }"

echo "Alias swapped. Old index ${OLD_INDEX} retained for 24h rollback."
echo "Run 'curl -XDELETE ${ES_URL}/${OLD_INDEX}' after confirmation."
```

## Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Search p50 latency | < 100ms | Elasticsearch `took` field |
| Search p95 latency | < 500ms | Application-level histogram |
| Search p99 latency | < 1000ms | Application-level histogram |
| Autocomplete p95 latency | < 200ms | Application-level histogram |
| Indexing lag (event created to searchable) | < 5s | Kafka consumer lag + ES refresh interval |
| Index throughput | > 5,000 docs/s | Bulk API monitoring |

### Latency Optimization Strategies

1. **Coordinating nodes**: Dedicated coordinating-only nodes handle query parsing and result aggregation, offloading data nodes.
2. **Shard sizing**: Target 20-40 GB per shard for optimal query performance. With 3 shards and 1 replica, the events index can handle up to 120 GB before resharding.
3. **Query caching**: Elasticsearch's request cache is enabled for filter-only queries. Frequent queries (e.g., "upcoming events in Sao Paulo") are cached at the shard level.
4. **Application-level caching**: Search results for popular queries are cached in Redis with a 30-second TTL, reducing Elasticsearch load by ~60% during peak traffic.
5. **Field data**: `doc_values` are enabled for all keyword and numeric fields (Elasticsearch default), avoiding field data loading for sorting and aggregations.

## Eventual Consistency Tradeoffs

### Accepted Inconsistencies

| Scenario | Inconsistency Window | Impact | Mitigation |
|----------|---------------------|--------|------------|
| New event created | 1-5s until searchable | Users cannot find just-created event | Acceptable; events are created hours/days before on-sale |
| Event updated (name, venue) | 1-5s until reflected | Search shows stale data briefly | Acceptable; updates are infrequent |
| Tickets sold (available count) | 5-30s until reflected | Search shows inflated availability | Display "Limited availability" instead of exact count |
| Event cancelled | 1-5s until removed | Cancelled event appears in results | Search results include status; UI filters cancelled events |

### Consistency Controls

- **Event detail page**: Always fetched from PostgreSQL (via event service), not from Elasticsearch. Users see real-time data when they click through from search results.
- **Available ticket count**: Treated as an approximation in search results. The exact count is fetched from PostgreSQL when the user enters the booking flow.
- **Stale result protection**: Each search result includes `updated_at`. The client can compare this with the detail page to detect stale data.

## Monitoring

### Key Metrics

- `elasticsearch_cluster_health_status` -- cluster color (green/yellow/red).
- `elasticsearch_indices_docs_count` -- document count per index.
- `elasticsearch_search_query_time_seconds` -- query latency histogram.
- `elasticsearch_indexing_index_time_seconds` -- indexing latency histogram.
- `kafka_consumer_group_lag{group="search-indexer"}` -- indexing pipeline lag.
- `momentum_search_cache_hit_ratio` -- Redis cache hit rate for search queries.

### Alerts

| Alert | Condition | Severity |
|-------|-----------|----------|
| Cluster Red | `cluster_health == red` for 2 min | P1 |
| Cluster Yellow | `cluster_health == yellow` for 10 min | P2 |
| Search p95 > 500ms | 95th percentile latency exceeds 500ms for 5 min | P2 |
| Indexing lag > 30s | Kafka consumer lag exceeds 30 seconds | P2 |
| Indexing lag > 5min | Kafka consumer lag exceeds 5 minutes | P1 |
| DLT messages | Any message in dead letter topic | P3 |

## Related Documents

- [ADR-0002: Search Engine Selection](../adr/0002-search-engine.md)
- [Architecture Overview](./architecture-overview.md)
- [Operational Runbook](../runbooks/operational-runbook.md)
