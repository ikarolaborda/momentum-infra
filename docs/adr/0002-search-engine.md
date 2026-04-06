# ADR-0002: Search Engine Selection -- Elasticsearch 8

| Field       | Value                        |
|-------------|------------------------------|
| **Status**  | Accepted                     |
| **Date**    | 2026-04-06                   |
| **Deciders**| Platform Engineering Team    |

## Context

Momentum requires full-text search across events, venues, artists, and categories. The search experience must support:

- **Portuguese language awareness** -- correct stemming, accent folding, and stop word removal for the Brazilian and Portuguese markets.
- **Typo tolerance** -- users frequently misspell artist names and venue names; the system must return relevant results despite input errors.
- **Autocomplete** -- sub-200ms suggestions as the user types, starting from 2 characters.
- **High availability** -- search must remain operational during node failures; the 100:1 read bias means search is the most heavily exercised subsystem.
- **Scale** -- millions of events indexed, queried by 10M concurrent users during peak on-sales.
- **Eventual consistency** -- acceptable for search results to lag writes by a few seconds, provided the indexing pipeline is reliable.

## Candidates Evaluated

### 1. Elasticsearch 8

- **Portuguese analyzers**: Built-in `portuguese` analyzer with configurable stemmer (`portuguese_rslp` or `light_portuguese`), `asciifolding` filter for accent normalization (e.g., "Sao Paulo" matches "Sao Paulo"), and `portuguese` stop word list.
- **Fuzzy matching**: `fuzziness: "AUTO"` on `match` queries adjusts edit distance based on term length (0 edits for 1-2 chars, 1 for 3-5, 2 for 6+). Handles common typos transparently.
- **Autocomplete**: Edge n-gram tokenizer (min 2, max 15) on a dedicated `suggest` sub-field provides prefix-based completion with sub-100ms response times.
- **Inverted index**: Optimized for read-heavy workloads; search queries do not lock or contend with indexing.
- **HA**: Native cluster support with configurable shard replicas, cross-zone allocation awareness, and automatic failover. Supports hot-warm-cold tiered architecture.
- **Ecosystem**: Mature client libraries (`@elastic/elasticsearch` for Node.js), Kibana for operational visibility, ILM for index lifecycle management.

### 2. Meilisearch

- **Strengths**: Simple API, built-in typo tolerance, fast out-of-the-box with zero configuration.
- **Weaknesses**:
  - Limited production HA story -- no native multi-node clustering until recently; less battle-tested at scale.
  - Fewer analyzer options -- no configurable stemmer pipelines, limited control over tokenization.
  - No edge n-gram equivalent -- relies on prefix search which is less flexible.
  - Single-node indexing bottleneck -- all writes go through a single process.
  - Less mature monitoring and operational tooling.

### 3. PostgreSQL Full-Text Search (tsvector/tsquery)

- **Strengths**: No additional infrastructure; queries co-located with data; transactionally consistent.
- **Weaknesses**:
  - **No typo tolerance** -- `tsquery` requires exact token matches after stemming; a misspelled term returns zero results.
  - **Limited stemming** -- Portuguese stemmer exists but is less configurable than Elasticsearch's analyzer chains.
  - **No edge n-gram** -- autocomplete requires `LIKE 'prefix%'` with trigram indexes, which is slower and less flexible.
  - **Read contention** -- full-text search queries compete with transactional workloads on the same database, increasing p99 latency under load.
  - **Scaling ceiling** -- cannot independently scale search capacity without scaling the entire database.

## Decision

**Adopt Elasticsearch 8 as the search engine for all full-text search, autocomplete, and faceted filtering in Momentum.**

## Rationale

### Portuguese Language Support

Elasticsearch's analyzer chain is fully configurable:

```json
{
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
        "filter": ["lowercase", "asciifolding"]
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
}
```

This enables:
- "Sao Paulo" matching "Sao Paulo" via `asciifolding`.
- "apresentacao" matching "apresentacoes" via Portuguese stemming.
- Common stop words ("de", "do", "da", "em", "para") removed to improve relevance.

### Fuzzy Matching

`fuzziness: "AUTO"` provides intelligent typo tolerance:

```json
{
  "query": {
    "multi_match": {
      "query": "coldpaly",
      "fields": ["name^3", "name.portuguese", "venue_name", "artists.name^2"],
      "fuzziness": "AUTO",
      "prefix_length": 1
    }
  }
}
```

- "coldpaly" matches "Coldplay" (edit distance 1).
- `prefix_length: 1` ensures the first character must match, reducing false positives.

### Autocomplete via Edge N-gram

A dedicated `suggest` sub-field with edge n-gram tokenization:

```json
{
  "name": {
    "type": "text",
    "analyzer": "momentum_portuguese",
    "fields": {
      "suggest": {
        "type": "text",
        "analyzer": "momentum_autocomplete",
        "search_analyzer": "standard"
      }
    }
  }
}
```

The `search_analyzer` uses `standard` (not edge n-gram) so that the user's input is matched against pre-computed n-grams, yielding fast prefix completion.

### High Availability

- **3-node minimum cluster** with 1 replica per shard ensures tolerance of a single node failure.
- **Allocation awareness** by availability zone prevents both primary and replica from residing in the same zone.
- **Dedicated master-eligible nodes** (3) prevent split-brain and isolate cluster coordination from search workloads.

### Why Not Meilisearch?

Meilisearch is an excellent choice for smaller-scale applications with simpler requirements. However, Momentum's needs -- configurable Portuguese analyzer chains, production-grade multi-node HA, edge n-gram autocomplete, and operational maturity at scale -- exceed Meilisearch's current capabilities.

### Why Not PostgreSQL Full-Text Search?

PostgreSQL FTS eliminates infrastructure complexity but introduces unacceptable limitations: zero typo tolerance means a single misspelled character yields no results, and search queries would compete with booking transactions on the same database. At 10M concurrent users, search must scale independently.

## Consequences

### Positive

- Rich, configurable text analysis for Portuguese and future language expansion.
- Typo-tolerant search improves user experience and conversion rates.
- Sub-100ms autocomplete via edge n-gram.
- Independent scaling of search capacity via Elasticsearch cluster expansion.
- Kibana provides operational dashboards for search performance monitoring.

### Negative

- Additional infrastructure to operate (3+ node Elasticsearch cluster).
- Search results are eventually consistent; indexing lag (typically 1-3 seconds) means newly created events are not immediately searchable.
- Elasticsearch mapping changes require reindexing; schema evolution must be planned.
- Memory-intensive -- each data node requires significant heap (typically 50% of available RAM, capped at 31 GB).

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Elasticsearch cluster instability | Dedicated master nodes, circuit breakers, heap monitoring, slow log analysis |
| Index corruption | Daily snapshots to S3/GCS; automated restore procedures documented in runbook |
| Mapping drift between services | Index mappings managed as code in the search service; validated in CI |
| Indexing pipeline lag | Kafka consumer lag monitoring with alerts at > 5s; dead letter topic for failed documents |

## References

- Elasticsearch Portuguese Analyzer: https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-lang-analyzer.html
- Elasticsearch Fuzzy Query: https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-fuzzy-query.html
- Meilisearch vs Elasticsearch: https://docs.meilisearch.com/learn/what_is_meilisearch/comparison_to_alternatives.html
