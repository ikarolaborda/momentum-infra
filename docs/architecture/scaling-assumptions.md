# Momentum -- Scaling Assumptions

## Target Scale

| Metric | Value | Notes |
|--------|-------|-------|
| Concurrent users (peak) | 10,000,000 | During a major on-sale event |
| Concurrent users (steady state) | 500,000 | Normal browsing and booking |
| Read/write ratio | 100:1 | Heavily read-biased |

## Throughput Estimates

### Request Rate Derivation

Assumptions:
- Each active user generates 1 request every 5 seconds during peak (browsing, polling queue status, searching).
- 10M concurrent users / 5s = **2,000,000 requests/second** at absolute peak.
- Read requests: ~1,980,000/s (99%).
- Write requests: ~20,000/s (1%) -- dominated by reservation attempts.

### By Endpoint Category

| Category | Requests/s (Peak) | Requests/s (Steady) | Notes |
|----------|-------------------|---------------------|-------|
| Search / Autocomplete | 800,000 | 40,000 | Most frequent user action |
| Event detail pages | 600,000 | 30,000 | Cached at Redis + CDN |
| Queue status polling | 400,000 | 0 | Only during on-sales with waiting room |
| Static assets (CDN) | 200,000 | 100,000 | Served from CDN, never hits origin |
| Reservation (write) | 15,000 | 500 | SELECT FOR UPDATE SKIP LOCKED |
| Payment (write) | 3,000 | 200 | Rate limited; follows successful reservation |
| Auth / user profile | 2,000 | 5,000 | JWT validation at gateway; profile reads cached |

### Throughput Budget

| System | Peak Throughput | Headroom Target | Provisioned Capacity |
|--------|----------------|-----------------|---------------------|
| API Gateway | 2,000,000 req/s | 30% | 2,600,000 req/s |
| Search (Elasticsearch) | 800,000 req/s | 40% | 1,120,000 req/s |
| Booking Service | 15,000 req/s | 50% | 22,500 req/s |
| PostgreSQL reads | 650,000 req/s | 30% | 845,000 req/s |
| PostgreSQL writes | 18,000 req/s | 50% | 27,000 req/s |
| Redis operations | 3,000,000 ops/s | 30% | 3,900,000 ops/s |
| Kafka messages | 50,000 msg/s | 40% | 70,000 msg/s |

## Service Instance Counts

### Peak Configuration

| Service | Instances | vCPU/Pod | Memory/Pod | Total vCPU | Total Memory |
|---------|-----------|----------|------------|------------|--------------|
| API Gateway | 40 | 2 | 2 GB | 80 | 80 GB |
| Event Service | 20 | 2 | 2 GB | 40 | 40 GB |
| Booking Service | 30 | 4 | 4 GB | 120 | 120 GB |
| Search Service | 20 | 2 | 2 GB | 40 | 40 GB |
| Payment Service | 10 | 2 | 2 GB | 20 | 20 GB |
| Notification Service | 8 | 1 | 1 GB | 8 | 8 GB |
| User Service | 10 | 2 | 2 GB | 20 | 20 GB |
| Waiting Room Service | 15 | 2 | 2 GB | 30 | 30 GB |
| **Application Total** | **153** | | | **358** | **358 GB** |

### Steady-State Configuration

| Service | Instances | Notes |
|---------|-----------|-------|
| API Gateway | 6 | Min replicas via HPA |
| Event Service | 4 | |
| Booking Service | 4 | |
| Search Service | 4 | |
| Payment Service | 3 | |
| Notification Service | 2 | |
| User Service | 3 | |
| Waiting Room Service | 0 | Scaled to zero when no on-sale active |
| **Application Total** | **26** | |

### Autoscaling Configuration

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: booking-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: booking-service
  minReplicas: 4
  maxReplicas: 30
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Percent
          value: 100          # Double pod count
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 25           # Reduce by 25%
          periodSeconds: 120
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "500"
```

**Scale-up is aggressive** (double every 60s) to handle on-sale spikes. **Scale-down is conservative** (25% reduction every 2 minutes, with 5-minute stabilization) to avoid oscillation.

## Database Sizing

### PostgreSQL Primary

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Instance type | r6g.4xlarge (16 vCPU, 128 GB RAM) | Booking writes are CPU and I/O intensive |
| Storage | 2 TB gp3, 16,000 IOPS, 1,000 MB/s throughput | Write-ahead log and table data |
| Max connections | 500 (via PgBouncer) | PgBouncer pool of 500 upstream connections; services connect to PgBouncer |
| Shared buffers | 32 GB (25% of RAM) | Standard PostgreSQL tuning |
| Effective cache size | 96 GB (75% of RAM) | Planner hint for index usage |
| Work mem | 64 MB | Per-sort/hash operation |
| WAL level | replica | Streaming replication to read replicas |

### PostgreSQL Read Replicas

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Instance type | r6g.2xlarge (8 vCPU, 64 GB RAM) | Read replicas handle less complex queries |
| Count | 2 (steady), 4 (peak) | Scale replicas for read throughput |
| Replication lag target | < 100ms | Monitored; reads requiring strong consistency go to primary |
| Connection pool | 300 per replica via PgBouncer | |

### Key Tables and Estimated Sizes

| Table | Rows (estimated) | Row Size | Total Size | Growth Rate |
|-------|-------------------|----------|------------|-------------|
| tickets | 50,000,000 | 256 bytes | ~12 GB | 1M/month |
| bookings | 20,000,000 | 512 bytes | ~10 GB | 500K/month |
| booking_items | 30,000,000 | 128 bytes | ~4 GB | 750K/month |
| events | 500,000 | 2 KB | ~1 GB | 10K/month |
| users | 10,000,000 | 512 bytes | ~5 GB | 200K/month |
| reservations | 30,000,000 | 256 bytes | ~8 GB | 1M/month |
| outbox | Variable | 1 KB | ~2 GB (pruned) | Pruned after publish |
| **Total** | | | **~42 GB** | |

### Index Strategy

| Index | Table | Columns | Type | Notes |
|-------|-------|---------|------|-------|
| idx_tickets_event_status | tickets | (event_id, status) | B-tree | Primary lookup for reservation |
| idx_tickets_reservation | tickets | (reservation_id) | B-tree | Expiry lookups |
| idx_bookings_user_event | bookings | (user_id, event_id) | B-tree | Per-user limit checks |
| idx_reservations_status_created | reservations | (status, created_at) | B-tree | Backup sweep job |
| idx_outbox_unpublished | outbox | (created_at) WHERE published = FALSE | Partial B-tree | Outbox poller |

## Redis Cluster Sizing

### Cluster Topology

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Nodes | 6 (3 masters, 3 replicas) | HA across 3 AZs |
| Instance type | r6g.2xlarge (8 vCPU, 52 GB RAM) | Redis is memory-bound |
| Total memory | 312 GB (6 x 52 GB) | Usable: ~200 GB (after replication overhead) |
| Max memory policy | allkeys-lru | Evict least recently used keys when memory is full |

### Memory Budget

| Use Case | Key Pattern | Estimated Keys | Avg Value Size | Memory |
|----------|-------------|----------------|----------------|--------|
| Event cache | `event:{id}` | 500,000 | 2 KB | 1 GB |
| Search cache | `search:{hash}` | 1,000,000 | 5 KB | 5 GB |
| Reservation TTLs | `reservation:{id}` | 100,000 (peak) | 512 bytes | 50 MB |
| Rate limit counters | `ratelimit:{scope}:{id}` | 10,000,000 | 64 bytes | 640 MB |
| Idempotency keys | `idempotency:{key}` | 500,000 | 1 KB | 500 MB |
| Queue tokens | `queue:{event}:{user}` | 5,000,000 (peak) | 256 bytes | 1.3 GB |
| Session data | `session:{token}` | 2,000,000 | 256 bytes | 512 MB |
| Distributed locks | `lock:{resource}` | 10,000 | 64 bytes | 1 MB |
| **Total** | | | | **~9 GB** |

The 200 GB usable capacity provides >20x headroom beyond estimated usage, accommodating traffic spikes and unexpected caching patterns.

### Operations Budget

| Operation | Type | Ops/s (Peak) | Notes |
|-----------|------|-------------|-------|
| Cache reads | GET | 1,500,000 | Event and search cache |
| Cache writes | SET/SETEX | 200,000 | Cache misses |
| Rate limit checks | INCR + EXPIRE | 800,000 | Per-request |
| Reservation TTL | SET + GET + DEL | 50,000 | Reservation lifecycle |
| Idempotency | GET + SETNX | 30,000 | Reservation + payment |
| Queue operations | ZADD + ZRANGEBYSCORE | 400,000 | Waiting room |
| **Total** | | **~3,000,000** | |

A 6-node Redis Cluster can sustain 4-5M ops/s, providing ~40% headroom.

## Elasticsearch Cluster Sizing

### Cluster Topology

| Component | Count | Instance Type | RAM | Storage | Purpose |
|-----------|-------|---------------|-----|---------|---------|
| Master nodes | 3 | m6g.large (2 vCPU, 8 GB) | 8 GB | 50 GB | Cluster coordination |
| Data nodes | 6 | r6g.2xlarge (8 vCPU, 64 GB) | 64 GB | 1 TB NVMe | Index storage, query execution |
| Coordinating nodes | 3 | c6g.xlarge (4 vCPU, 8 GB) | 8 GB | 50 GB | Query routing, aggregation |

### Index Configuration

| Index | Shards | Replicas | Estimated Size | Documents |
|-------|--------|----------|----------------|-----------|
| events | 6 | 1 | 5 GB | 500,000 |
| venues | 2 | 1 | 500 MB | 50,000 |
| artists | 2 | 1 | 200 MB | 100,000 |
| **Total** | 10 | 10 | **~6 GB** primary, **~12 GB** with replicas | |

### Query Throughput

| Query Type | p50 Latency | p95 Latency | Target Throughput |
|------------|-------------|-------------|-------------------|
| Full-text search | 30ms | 100ms | 50,000 q/s |
| Autocomplete | 10ms | 50ms | 100,000 q/s |
| Faceted search | 50ms | 200ms | 20,000 q/s |

With application-level Redis caching (30s TTL, ~60% hit rate), the effective Elasticsearch query load is:

- Search: ~320,000 req/s peak x 40% cache miss = **~128,000 q/s** to Elasticsearch.
- Autocomplete: ~480,000 req/s peak x 40% cache miss = **~192,000 q/s** to Elasticsearch.

A 6-data-node cluster with 3 coordinating nodes can handle ~400,000 simple queries/second, providing adequate headroom.

### JVM Heap Configuration

- Data nodes: 31 GB heap (50% of 64 GB RAM, capped below 32 GB for compressed oops).
- Remaining RAM used for OS page cache (critical for Lucene segment caching).
- Master nodes: 4 GB heap.
- Coordinating nodes: 4 GB heap.

## Kafka Partition Strategy

### Topic Configuration

| Topic | Partitions | Replication Factor | Retention | Key | Notes |
|-------|------------|-------------------|-----------|-----|-------|
| events.created | 12 | 3 | 7 days | event_id | Moderate volume |
| events.updated | 12 | 3 | 7 days | event_id | Moderate volume |
| events.cancelled | 6 | 3 | 7 days | event_id | Low volume |
| bookings.reserved | 24 | 3 | 3 days | ticket_id | High volume during on-sale |
| bookings.confirmed | 24 | 3 | 30 days | ticket_id | Audit trail |
| bookings.expired | 12 | 3 | 3 days | reservation_id | Moderate volume |
| bookings.cancelled | 6 | 3 | 7 days | reservation_id | Low volume |
| payments.completed | 12 | 3 | 30 days | reservation_id | Financial audit |
| payments.failed | 6 | 3 | 30 days | reservation_id | Low volume |
| payments.refunded | 6 | 3 | 90 days | booking_id | Financial audit |

### Partition Count Rationale

Partitions = max(expected_consumer_instances, peak_throughput / per_partition_throughput).

- `bookings.reserved` at 24 partitions: peak 15,000 msg/s / ~1,000 msg/s per partition = 15 partitions minimum. 24 allows scaling to 24 consumer instances.
- `events.created` at 12 partitions: peak 100 msg/s; 12 partitions provides parallelism for the search indexer consumer group.

### Broker Cluster

| Parameter | Value |
|-----------|-------|
| Brokers | 3 (KRaft mode, no ZooKeeper) |
| Instance type | m6g.2xlarge (8 vCPU, 32 GB RAM) |
| Storage | 1 TB gp3 per broker |
| Replication factor | 3 (all topics) |
| Min in-sync replicas | 2 |
| Log retention | Topic-specific (see above) |
| Max message size | 1 MB |
| Batch size | 64 KB |
| Linger ms | 5 ms |

### Consumer Group Sizing

| Consumer Group | Topic(s) | Instances (Steady) | Instances (Peak) |
|----------------|----------|-------------------|-----------------|
| search-indexer | events.* | 3 | 12 |
| notification-service | bookings.confirmed, events.updated | 2 | 8 |
| analytics-service | all topics | 2 | 6 |
| booking-confirmer | payments.completed, payments.failed | 3 | 12 |
| audit-logger | all topics | 1 | 3 |

## Network Bandwidth

| Path | Peak Bandwidth | Notes |
|------|---------------|-------|
| CDN -> WAF -> Gateway | 10 Gbps | Edge traffic, mostly small JSON |
| Gateway -> Services | 5 Gbps | Internal east-west traffic |
| Services -> PostgreSQL | 2 Gbps | Query results, write operations |
| Services -> Redis | 3 Gbps | Cache reads dominate |
| Services -> Elasticsearch | 2 Gbps | Search responses |
| Services -> Kafka | 500 Mbps | Event messages |

All internal communication uses Kubernetes pod networking within a single VPC. Cross-AZ traffic is minimized via topology-aware routing.

## Cost Estimate (Monthly)

| Component | Instance/Config | Monthly Cost (USD) |
|-----------|----------------|-------------------|
| Kubernetes nodes (peak: 30 x m6g.2xlarge) | On-demand + Spot mix | ~$15,000 |
| PostgreSQL (1 primary + 2 replicas) | RDS r6g.4xlarge + r6g.2xlarge x 2 | ~$6,000 |
| Redis Cluster (6 nodes) | ElastiCache r6g.2xlarge x 6 | ~$8,000 |
| Elasticsearch (12 nodes) | OpenSearch r6g.2xlarge x 6 + others | ~$10,000 |
| Kafka (3 brokers) | MSK m6g.2xlarge x 3 | ~$4,000 |
| Network / Load Balancer | ALB + data transfer | ~$3,000 |
| Storage / Backups | EBS + S3 | ~$2,000 |
| **Total** | | **~$48,000/month** |

These estimates assume AWS sa-east-1 pricing with a mix of on-demand and reserved instances. Actual costs will vary based on reserved instance commitments and sustained use discounts.

## Related Documents

- [Architecture Overview](./architecture-overview.md)
- [Anti-Bot and Fairness](./anti-bot-and-fairness.md)
- [Operational Runbook](../runbooks/operational-runbook.md)
