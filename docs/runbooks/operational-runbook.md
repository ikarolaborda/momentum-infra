# Momentum -- Operational Runbook

## Table of Contents

1. [Deployment Procedures](#deployment-procedures)
2. [Scaling Procedures](#scaling-procedures)
3. [Incident Response](#incident-response)
4. [Database Maintenance](#database-maintenance)
5. [Redis Cluster Operations](#redis-cluster-operations)
6. [Elasticsearch Reindexing](#elasticsearch-reindexing)
7. [Kafka Operations](#kafka-operations)
8. [Monitoring and Alerting](#monitoring-and-alerting)
9. [Common Failure Modes and Recovery](#common-failure-modes-and-recovery)

---

## Service Overview

| Service | Port | Replicas (Steady) | Replicas (Peak) | Critical Path |
|---------|------|-------------------|-----------------|---------------|
| API Gateway | 3000 | 6 | 40 | Yes -- all traffic |
| Event Service | 3001 | 4 | 20 | Yes -- reads |
| Booking Service | 3002 | 4 | 30 | Yes -- writes |
| Search Service | 3003 | 4 | 20 | Degradable |
| Payment Service | 3004 | 3 | 10 | Yes -- payment flow |
| Notification Service | 3005 | 2 | 8 | Degradable |
| User Service | 3006 | 3 | 10 | Yes -- auth |
| Waiting Room Service | 3007 | 0 | 15 | On-sale only |

### Health Check Endpoints

- `GET /health` -- full health check (database, Redis, Elasticsearch, Kafka)
- `GET /health/ready` -- readiness probe (lightweight, checks service can accept traffic)
- `GET /health/live` -- liveness probe (checks process is running)
- `GET /metrics` -- Prometheus metrics endpoint

---

## Deployment Procedures

### Standard Service Deployment

**Trigger**: Code merged to `main` branch.

**Pipeline**: GitHub Actions -> Docker build -> Push to ECR -> ArgoCD sync.

**Steps**:

1. **Pre-deployment checks**:
   ```bash
   # Verify cluster health
   kubectl get nodes -o wide
   kubectl top nodes

   # Check current deployment status
   kubectl -n momentum-prod get deployments
   kubectl -n momentum-prod get pods --field-selector=status.phase!=Running
   ```

2. **Deploy via ArgoCD**:
   ```bash
   # ArgoCD auto-syncs on image tag update. For manual sync:
   argocd app sync momentum-booking-service
   argocd app wait momentum-booking-service --health
   ```

3. **Verify rollout**:
   ```bash
   kubectl -n momentum-prod rollout status deployment/booking-service --timeout=300s

   # Check pod health
   kubectl -n momentum-prod get pods -l app=booking-service

   # Verify health endpoint
   kubectl -n momentum-prod exec -it deploy/booking-service -- curl -s localhost:3002/health
   ```

4. **Post-deployment validation**:
   ```bash
   # Check error rate in Grafana (should not increase)
   # Dashboard: Momentum > Service Health > Error Rate

   # Verify Kafka consumer lag is not increasing
   kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
     kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
     --group booking-confirmer --describe
   ```

### Rollback Procedure

```bash
# Identify the previous revision
kubectl -n momentum-prod rollout history deployment/booking-service

# Rollback to previous revision
kubectl -n momentum-prod rollout undo deployment/booking-service

# Or rollback to a specific revision
kubectl -n momentum-prod rollout undo deployment/booking-service --to-revision=42

# Verify rollback
kubectl -n momentum-prod rollout status deployment/booking-service
```

### Database Migration Deployment

Migrations must be backward-compatible (additive only). Destructive changes (column removal, type change) require a two-phase deployment.

```bash
# Run migrations via a Kubernetes Job
kubectl -n momentum-prod apply -f k8s/jobs/migration-job.yaml

# Monitor migration progress
kubectl -n momentum-prod logs -f job/db-migration

# Verify migration status
kubectl -n momentum-prod exec -it deploy/booking-service -- \
  npx typeorm migration:show -d dist/data-source.js
```

**WARNING**: Never run destructive migrations during peak hours. Schedule during maintenance windows (Tuesdays/Wednesdays, 03:00-05:00 UTC-3).

### Pre-On-Sale Deployment Freeze

| Milestone | Action |
|-----------|--------|
| T-24h | Deployment freeze for booking, payment, and gateway services |
| T-4h | Scale services to peak configuration |
| T-2h | Run synthetic load test against staging |
| T-30m | Final health checks; confirm all pods healthy |
| T-0 | Monitor dashboards actively; incident channel open |
| T+2h | Evaluate scale-down; lift deployment freeze |

---

## Scaling Procedures

### Manual Scale-Up Before On-Sale

```bash
# Scale all services to peak configuration
kubectl -n momentum-prod scale deployment/api-gateway --replicas=40
kubectl -n momentum-prod scale deployment/booking-service --replicas=30
kubectl -n momentum-prod scale deployment/event-service --replicas=20
kubectl -n momentum-prod scale deployment/search-service --replicas=20
kubectl -n momentum-prod scale deployment/payment-service --replicas=10
kubectl -n momentum-prod scale deployment/notification-service --replicas=8
kubectl -n momentum-prod scale deployment/user-service --replicas=10
kubectl -n momentum-prod scale deployment/waiting-room-service --replicas=15

# Verify all pods are running and ready
kubectl -n momentum-prod get pods -l tier=application --field-selector=status.phase=Running | wc -l

# Activate waiting room for the event
curl -X POST http://api-gateway:3000/admin/queue/activate \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <admin-token>' \
  -d '{"event_id": "<EVENT_ID>", "duration_seconds": 7200}'
```

### Manual Scale-Down After On-Sale

Wait at least 30 minutes after peak traffic subsides before scaling down.

```bash
# Scale down gradually -- 50% first
kubectl -n momentum-prod scale deployment/booking-service --replicas=15
kubectl -n momentum-prod scale deployment/api-gateway --replicas=20

# Wait 15 minutes; verify metrics are stable

# Scale to steady state
kubectl -n momentum-prod scale deployment/booking-service --replicas=4
kubectl -n momentum-prod scale deployment/api-gateway --replicas=6
kubectl -n momentum-prod scale deployment/event-service --replicas=4
kubectl -n momentum-prod scale deployment/search-service --replicas=4
kubectl -n momentum-prod scale deployment/payment-service --replicas=3
kubectl -n momentum-prod scale deployment/notification-service --replicas=2
kubectl -n momentum-prod scale deployment/user-service --replicas=3
kubectl -n momentum-prod scale deployment/waiting-room-service --replicas=0
```

### Adding PostgreSQL Read Replicas

```bash
# Via AWS CLI (RDS)
aws rds create-db-instance-read-replica \
  --db-instance-identifier momentum-prod-replica-3 \
  --source-db-instance-identifier momentum-prod-primary \
  --db-instance-class db.r6g.2xlarge \
  --availability-zone sa-east-1c

# Update PgBouncer configuration to include new replica
kubectl -n momentum-prod edit configmap pgbouncer-read-config
kubectl -n momentum-prod rollout restart deployment/pgbouncer-read

# Verify replication is streaming
aws rds describe-db-instances \
  --db-instance-identifier momentum-prod-replica-3 \
  --query 'DBInstances[0].StatusInfos'
```

### Scaling Redis Cluster

```bash
# Add a shard to Redis Cluster (via AWS ElastiCache)
aws elasticache modify-replication-group \
  --replication-group-id momentum-prod-redis \
  --num-node-groups 4 \
  --apply-immediately

# Monitor resharding progress
aws elasticache describe-replication-groups \
  --replication-group-id momentum-prod-redis \
  --query 'ReplicationGroups[0].Status'
```

### HPA Configuration

Auto-scaling is configured for all services. Check and modify HPA settings:

```bash
# View current HPA status
kubectl -n momentum-prod get hpa

# Describe HPA for booking service
kubectl -n momentum-prod describe hpa booking-service-hpa

# Temporarily override HPA min replicas (e.g., before on-sale)
kubectl -n momentum-prod patch hpa booking-service-hpa \
  --patch '{"spec":{"minReplicas":30}}'
```

---

## Incident Response

### Severity Levels

| Level | Description | Response Time | Escalation | Examples |
|-------|-------------|---------------|------------|----------|
| **P1** | Service outage affecting bookings | 5 minutes | Immediate page | Booking service down, DB primary failure, double-booking detected |
| **P2** | Degraded performance or partial outage | 15 minutes | Page after 15 min | High latency (>2s p95), ES cluster yellow, consumer lag >5min |
| **P3** | Minor issue, no user impact | 1 hour | Slack notification | DLT messages, non-critical service degradation |
| **P4** | Informational | Next business day | Email | Capacity warning, routine maintenance needed |

### Incident Response Checklist

**On Pager Alert (P1/P2)**:

1. **Acknowledge** the alert in PagerDuty within SLA.
2. **Assess scope**:
   ```bash
   # Quick health check across all services
   kubectl -n momentum-prod get pods --field-selector=status.phase!=Running
   kubectl -n momentum-prod top pods --sort-by=cpu | head -20

   # Check recent Kubernetes events
   kubectl -n momentum-prod get events --sort-by='.lastTimestamp' | tail -20

   # Check service health endpoints
   for svc in api-gateway event-service booking-service search-service payment-service; do
     echo "=== $svc ==="
     kubectl -n momentum-prod exec deploy/$svc -- curl -s localhost:3000/health 2>/dev/null || echo "UNREACHABLE"
   done
   ```
3. **Communicate**: Post in #incidents Slack channel with initial assessment.
4. **Mitigate**: Apply the fastest fix (restart, rollback, or scale).
5. **Investigate**: After mitigation, identify root cause.
6. **Resolve**: Deploy permanent fix.
7. **Post-mortem**: Blameless post-mortem within 48 hours for P1 incidents.

### Emergency Procedures

**Kill Switch -- Disable Bookings**:
```bash
kubectl -n momentum-prod set env deployment/booking-service BOOKINGS_ENABLED=false
kubectl -n momentum-prod rollout restart deployment/booking-service
```

**Kill Switch -- Maintenance Mode**:
```bash
kubectl -n momentum-prod annotate ingress momentum-ingress \
  nginx.ingress.kubernetes.io/custom-http-errors="503" \
  nginx.ingress.kubernetes.io/default-backend=maintenance-page
```

**Double-Booking Detected (P1)**:
```sql
-- 1. Immediately query for duplicate bookings
SELECT ticket_id, COUNT(*) as booking_count
FROM booking_items
GROUP BY ticket_id
HAVING COUNT(*) > 1;

-- 2. Identify affected bookings
SELECT bi.ticket_id, b.id as booking_id, b.user_id, b.created_at
FROM booking_items bi
JOIN bookings b ON b.id = bi.booking_id
WHERE bi.ticket_id IN (
  SELECT ticket_id FROM booking_items GROUP BY ticket_id HAVING COUNT(*) > 1
)
ORDER BY bi.ticket_id, b.created_at;

-- 3. The FIRST booking per ticket_id is valid; all others must be refunded
```

---

## Database Maintenance

### Routine Maintenance

**Vacuum and Analyze** (weekly, automated via pg_cron):
```sql
-- Check tables needing vacuum
SELECT schemaname, relname, n_dead_tup, n_live_tup, last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;

-- Manual vacuum if autovacuum is behind
VACUUM (VERBOSE, ANALYZE) tickets;
VACUUM (VERBOSE, ANALYZE) reservations;
VACUUM (VERBOSE, ANALYZE) booking_items;
```

**Index Maintenance**:
```sql
-- Check index bloat
SELECT
  schemaname, tablename, indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;

-- Reindex concurrently (no locks)
REINDEX INDEX CONCURRENTLY idx_tickets_event_status;
REINDEX INDEX CONCURRENTLY idx_reservations_status_created;
```

**Long-Running Queries**:
```sql
-- Find queries running longer than 30 seconds
SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > interval '30 seconds'
  AND state != 'idle'
ORDER BY duration DESC;

-- Cancel a long-running query (graceful)
SELECT pg_cancel_backend(<pid>);

-- Terminate a stuck connection (last resort)
SELECT pg_terminate_backend(<pid>);
```

### Connection Pool Monitoring

```bash
# Check PgBouncer stats
kubectl -n momentum-prod exec -it deploy/pgbouncer -- \
  psql -p 6432 pgbouncer -c "SHOW POOLS;"

kubectl -n momentum-prod exec -it deploy/pgbouncer -- \
  psql -p 6432 pgbouncer -c "SHOW STATS;"

kubectl -n momentum-prod exec -it deploy/pgbouncer -- \
  psql -p 6432 pgbouncer -c "SHOW CLIENTS;" | wc -l
```

**Alert thresholds**:
- Pool utilization > 80%: P3 alert.
- Pool utilization > 95%: P2 alert.
- Client wait time > 1s: P2 alert.

### Lock Monitoring

```sql
-- Check for lock contention
SELECT blocked.pid AS blocked_pid,
       blocked.query AS blocked_query,
       blocking.pid AS blocking_pid,
       blocking.query AS blocking_query,
       now() - blocked.query_start AS blocked_duration
FROM pg_stat_activity blocked
JOIN pg_locks bl ON bl.pid = blocked.pid
JOIN pg_locks kl ON kl.locktype = bl.locktype
  AND kl.database IS NOT DISTINCT FROM bl.database
  AND kl.relation IS NOT DISTINCT FROM bl.relation
JOIN pg_stat_activity blocking ON blocking.pid = kl.pid
WHERE NOT bl.granted AND kl.granted
ORDER BY blocked_duration DESC;
```

### Ticket Inventory Check

```sql
-- Check ticket status distribution per event
SELECT e.name, t.status, COUNT(*) as count
FROM tickets t
JOIN events e ON e.id = t.event_id
GROUP BY e.name, t.status
ORDER BY e.name, t.status;

-- Check for orphaned reservations (reserved past TTL with no Redis key)
SELECT COUNT(*) as orphaned_count FROM tickets
WHERE status = 'reserved'
  AND reserved_at < NOW() - INTERVAL '10 minutes';
```

### Outbox Table Health and Pruning

```sql
-- Check outbox status
SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE published = FALSE) AS unpublished,
  COUNT(*) FILTER (WHERE published = TRUE) AS published,
  MIN(created_at) FILTER (WHERE published = FALSE) AS oldest_unpublished,
  pg_size_pretty(pg_total_relation_size('outbox')) AS table_size
FROM outbox;

-- Prune published entries older than 7 days (daily cron)
DELETE FROM outbox
WHERE published = TRUE
  AND published_at < NOW() - INTERVAL '7 days';
```

Alert if unpublished rows exceed 1,000 or oldest unpublished is > 30 seconds old.

### Backup Verification

```bash
# List available backups
aws rds describe-db-snapshots \
  --db-instance-identifier momentum-prod-primary \
  --query 'DBSnapshots[*].[DBSnapshotIdentifier,SnapshotCreateTime,Status]' \
  --output table

# Point-in-time restore test (use a separate instance)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier momentum-prod-primary \
  --target-db-instance-identifier momentum-restore-test \
  --restore-time "2026-04-06T10:00:00Z"

# After verification, delete the test instance
aws rds delete-db-instance \
  --db-instance-identifier momentum-restore-test \
  --skip-final-snapshot
```

---

## Redis Cluster Operations

### Health Check

```bash
# Cluster info
kubectl -n momentum-prod exec -it redis-0 -- redis-cli cluster info

# Node status
kubectl -n momentum-prod exec -it redis-0 -- redis-cli cluster nodes

# Memory usage per node
for i in 0 1 2 3 4 5; do
  echo "=== redis-$i ==="
  kubectl -n momentum-prod exec -it redis-$i -- redis-cli info memory | grep used_memory_human
done
```

### Reservation Monitoring

```bash
# Count active reservations (use SCAN, not KEYS, in production)
kubectl -n momentum-prod exec -it redis-0 -- \
  redis-cli --scan --pattern 'reservation:*' | wc -l

# Check a specific reservation
kubectl -n momentum-prod exec -it redis-0 -- \
  redis-cli get "reservation:<reservation_id>"

# Check TTL of a reservation
kubectl -n momentum-prod exec -it redis-0 -- \
  redis-cli ttl "reservation:<reservation_id>"
```

### Rate Limit Operations

```bash
# Check rate limit keys count
kubectl -n momentum-prod exec -it redis-0 -- \
  redis-cli --scan --pattern 'ratelimit:*' | wc -l

# Emergency: clear all rate limits for a specific IP
kubectl -n momentum-prod exec -it redis-0 -- \
  redis-cli --scan --pattern 'ratelimit:*:<IP_ADDRESS>' | xargs redis-cli del

# Emergency: clear all rate limits (use with extreme caution)
kubectl -n momentum-prod exec -it redis-0 -- \
  redis-cli --scan --pattern 'ratelimit:*' | xargs redis-cli del
```

### Waiting Room Queue Operations

```bash
# Check queue status for an event
kubectl -n momentum-prod exec -it redis-0 -- redis-cli get "queue:active:<event_id>"

# Check queue depth
kubectl -n momentum-prod exec -it redis-0 -- redis-cli zcard "queue:waiting:<event_id>"

# Check current admitted count
kubectl -n momentum-prod exec -it redis-0 -- redis-cli get "queue:admitted:<event_id>"
```

### Slow Log

```bash
# Check for slow commands (default threshold: 10ms)
kubectl -n momentum-prod exec -it redis-0 -- redis-cli slowlog get 20

# Reset slow log
kubectl -n momentum-prod exec -it redis-0 -- redis-cli slowlog reset
```

### Failover Procedures

Automatic failover is handled by Redis Cluster. Manual intervention is needed only if automatic failover fails.

```bash
# Manual failover of a master to its replica
kubectl -n momentum-prod exec -it redis-replica-0 -- redis-cli cluster failover

# Verify new topology
kubectl -n momentum-prod exec -it redis-0 -- redis-cli cluster nodes | grep master

# Replace a failed node
kubectl -n momentum-prod exec -it redis-0 -- \
  redis-cli cluster forget <failed-node-id>
kubectl -n momentum-prod exec -it redis-0 -- \
  redis-cli cluster meet <new-node-ip> 6379
kubectl -n momentum-prod exec -it redis-new -- \
  redis-cli cluster replicate <master-node-id>
```

### Memory Pressure

If Redis approaches memory limits:

1. **Identify large keys**:
   ```bash
   kubectl -n momentum-prod exec -it redis-0 -- redis-cli --bigkeys
   ```

2. **Check for keys without TTL**:
   ```bash
   kubectl -n momentum-prod exec -it redis-0 -- \
     redis-cli --scan --count 1000 | head -50 | while read key; do
       TTL=$(redis-cli ttl "$key")
       if [ "$TTL" = "-1" ]; then echo "NO TTL: $key"; fi
     done
   ```

3. **Reduce cache TTLs** in application configuration if cache keys dominate.
4. **Add shards** if persistent data is growing beyond capacity.

---

## Elasticsearch Reindexing

### Zero-Downtime Reindex

```bash
#!/bin/bash
set -euo pipefail

OLD_INDEX="events_v1"
NEW_INDEX="events_v2"
ALIAS="events"
ES_URL="${ELASTICSEARCH_URL:-http://es-cluster:9200}"

echo "Step 1: Create new index with updated mapping..."
curl -s -XPUT "${ES_URL}/${NEW_INDEX}" \
  -H 'Content-Type: application/json' \
  -d @mappings/events.json

echo "Step 2: Start reindex from ${OLD_INDEX} to ${NEW_INDEX}..."
TASK_ID=$(curl -s -XPOST "${ES_URL}/_reindex?wait_for_completion=false" \
  -H 'Content-Type: application/json' \
  -d "{\"source\":{\"index\":\"${OLD_INDEX}\"},\"dest\":{\"index\":\"${NEW_INDEX}\"}}" \
  | jq -r '.task')

echo "Reindex task: ${TASK_ID}"

echo "Step 3: Monitoring progress..."
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

echo "Step 4: Verify document counts..."
OLD_COUNT=$(curl -s "${ES_URL}/${OLD_INDEX}/_count" | jq '.count')
NEW_COUNT=$(curl -s "${ES_URL}/${NEW_INDEX}/_count" | jq '.count')
echo "Old: ${OLD_COUNT}, New: ${NEW_COUNT}"

if [ "$OLD_COUNT" != "$NEW_COUNT" ]; then
  echo "ERROR: Document counts do not match. Aborting alias swap."
  exit 1
fi

echo "Step 5: Swap alias atomically..."
curl -s -XPOST "${ES_URL}/_aliases" \
  -H 'Content-Type: application/json' \
  -d "{
    \"actions\": [
      {\"remove\": {\"index\": \"${OLD_INDEX}\", \"alias\": \"${ALIAS}\"}},
      {\"add\": {\"index\": \"${NEW_INDEX}\", \"alias\": \"${ALIAS}\"}}
    ]
  }"

echo "Step 6: Done. Old index retained for 24h rollback."
echo "Delete old index after confirmation: curl -XDELETE ${ES_URL}/${OLD_INDEX}"
```

### Emergency Reindex (via Kafka Replay)

```bash
# 1. Create a fresh index
curl -XPUT "http://es-cluster:9200/events_recovery" \
  -H 'Content-Type: application/json' \
  -d @mappings/events.json

# 2. Stop consumers
kubectl -n momentum-prod scale deployment/search-service --replicas=0

# 3. Reset consumer offsets to replay all events
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --group search-indexer --all-topics \
  --reset-offsets --to-earliest --execute

# 4. Scale up consumers for faster reindex
kubectl -n momentum-prod scale deployment/search-service --replicas=12

# 5. Monitor progress
watch -n 5 'curl -s http://es-cluster:9200/events_recovery/_count | jq .count'

# 6. After reindex completes, swap alias and scale down
```

### Snapshot and Restore

```bash
# Create snapshot
curl -XPUT "http://es-cluster:9200/_snapshot/s3_backup/snapshot_$(date +%Y%m%d)" \
  -H 'Content-Type: application/json' \
  -d '{ "indices": "events,venues,artists" }'

# Check status
curl -s "http://es-cluster:9200/_snapshot/s3_backup/snapshot_20260406/_status" | jq '.snapshots[0].state'

# Restore (close index first)
curl -XPOST "http://es-cluster:9200/events/_close"
curl -XPOST "http://es-cluster:9200/_snapshot/s3_backup/snapshot_20260406/_restore" \
  -H 'Content-Type: application/json' \
  -d '{ "indices": "events" }'
curl -XPOST "http://es-cluster:9200/events/_open"
```

### Cluster Recovery

```bash
# Check health
curl -s "http://es-cluster:9200/_cluster/health?pretty"

# Find unassigned shards
curl -s "http://es-cluster:9200/_cat/shards?v&h=index,shard,prirep,state,unassigned.reason" \
  | grep UNASSIGNED

# Explain allocation failure
curl -s "http://es-cluster:9200/_cluster/allocation/explain?pretty"

# Retry failed allocations
curl -XPOST "http://es-cluster:9200/_cluster/reroute?retry_failed=true"

# Force primary allocation (LAST RESORT -- may lose data)
curl -XPOST "http://es-cluster:9200/_cluster/reroute" \
  -H 'Content-Type: application/json' \
  -d '{
    "commands": [{
      "allocate_stale_primary": {
        "index": "events",
        "shard": 0,
        "node": "data-node-1",
        "accept_data_loss": true
      }
    }]
  }'
```

---

## Kafka Operations

### Health Check

```bash
# List topics
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-topics.sh --bootstrap-server localhost:9092 --list

# Describe a topic
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-topics.sh --bootstrap-server localhost:9092 \
  --describe --topic bookings.reserved

# Check broker count
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-broker-api-versions.sh --bootstrap-server localhost:9092 | head -5
```

### Consumer Lag Monitoring

```bash
# List all consumer groups
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list

# Check lag for a specific group
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --group search-indexer --describe
```

**Alert thresholds**:

| Lag | Severity | Action |
|-----|----------|--------|
| > 1,000 messages | P3 | Investigate consumer health |
| > 10,000 messages or > 5 min | P2 | Scale consumers, check processing errors |
| > 100,000 messages or > 30 min | P1 | Escalate; consider offset reset if data loss is acceptable |

### Dead Letter Topic Management

```bash
# Check DLT message count
for topic in events.created.dlq events.updated.dlq bookings.reserved.dlq; do
  COUNT=$(kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
    kafka-run-class.sh kafka.tools.GetOffsetShell \
    --broker-list localhost:9092 --topic $topic 2>/dev/null | \
    awk -F: '{sum+=$3} END {print sum}')
  echo "$topic: $COUNT messages"
done

# Read DLT messages for inspection
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-console-consumer.sh --bootstrap-server localhost:9092 \
  --topic events.created.dlq \
  --from-beginning --max-messages 10 \
  --property print.key=true \
  --property print.timestamp=true
```

### Consumer Offset Reset

**IMPORTANT**: Stop consumers before resetting offsets.

```bash
# Stop consumers
kubectl -n momentum-prod scale deployment/search-service --replicas=0

# Reset to latest (skip all unprocessed)
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --group search-indexer --topic events.created \
  --reset-offsets --to-latest --execute

# Reset to a specific timestamp
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --group search-indexer --topic events.created \
  --reset-offsets --to-datetime "2026-04-06T10:00:00.000" --execute

# Restart consumers
kubectl -n momentum-prod scale deployment/search-service --replicas=4
```

### Topic Partition Increase

```bash
# Increase partitions (irreversible)
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-topics.sh --bootstrap-server localhost:9092 \
  --alter --topic bookings.reserved \
  --partitions 36

# NOTE: Existing messages are NOT redistributed. Messages with existing
# keys may be routed to different partitions. Ensure consumers can handle this.
```

### Kafka Disk Management

```bash
# Check broker disk usage
kubectl -n momentum-prod exec -it deploy/kafka-0 -- df -h /var/kafka-logs

# If disk > 80%, reduce retention for non-critical topics
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-configs.sh --bootstrap-server localhost:9092 \
  --alter --entity-type topics --entity-name bookings.expired \
  --add-config retention.ms=86400000  # 1 day
```

---

## Monitoring and Alerting

### Dashboard Structure

| Dashboard | Purpose | Key Panels |
|-----------|---------|------------|
| **Service Health** | Overall system status | Request rate, error rate, p50/p95/p99 latency per service |
| **Booking Flow** | Reservation and payment pipeline | Reservation success rate, payment conversion, TTL expirations |
| **Infrastructure** | Resource utilization | CPU, memory, disk, network per node/pod |
| **PostgreSQL** | Database performance | Query latency, connections, replication lag, TPS, lock contention |
| **Redis** | Cache and state | Hit rate, memory usage, ops/s, evictions, connected clients |
| **Elasticsearch** | Search performance | Query latency, indexing rate, cluster health, shard status |
| **Kafka** | Messaging health | Producer rate, consumer lag per group, broker disk usage |
| **On-Sale Monitor** | Event-specific during on-sale | Queue depth, admission rate, concurrent reservations, inventory |

### Critical Alerts

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| Service down | 0 healthy pods > 1 min | P1 | Check pod events, restart, rollback |
| Booking error rate | > 5% non-409 errors > 2 min | P1 | Check booking logs, DB health |
| Double-booking detected | booking_items duplicate ticket_id | P1 | Incident response, halt bookings |
| PostgreSQL primary down | Not responding > 30s | P1 | RDS automated failover; verify |
| PostgreSQL replication lag | > 5s for > 5 min | P2 | Check replica health, IO |
| Redis cluster degraded | Master unreachable > 1 min | P1 | Check failover, node health |
| Redis memory > 90% | used_memory > 90% maxmemory | P2 | Check key patterns, scale |
| Elasticsearch red | Cluster health red > 2 min | P1 | Check unassigned shards |
| Elasticsearch yellow | Cluster health yellow > 10 min | P2 | Check replica allocation |
| Kafka consumer lag | > 5 min any group | P2 | Scale consumers, check errors |
| Kafka disk > 80% | Broker disk usage > 80% | P2 | Increase retention pruning |
| API p95 latency | > 2s for > 5 min | P2 | Check downstream services |
| Outbox pending > 1000 | Unpublished outbox rows | P2 | Check outbox poller, Kafka |
| Reservation expiry failure | Stale reservations > 100 | P2 | Check Redis notifications, sweep job |
| Certificate expiry | TLS cert < 14 days | P3 | Renew certificate |

### Key Prometheus Metrics

```
# Application
http_request_duration_seconds{service, method, path, status}
http_requests_total{service, method, path, status}
booking_reservations_active{event_id}
booking_reservations_expired_total{reason}
booking_payments_total{status}

# PostgreSQL
pg_stat_activity_count{state}
pg_stat_replication_lag_seconds
pg_stat_user_tables_n_tup_ins

# Redis
redis_connected_clients
redis_used_memory_bytes
redis_keyspace_hits_total
redis_keyspace_misses_total

# Elasticsearch
elasticsearch_cluster_health_status
elasticsearch_indices_search_query_time_seconds

# Kafka
kafka_consumergroup_lag
kafka_brokers
```

### Log Aggregation

All services emit structured JSON logs via Pino. Logs are collected by Fluent Bit daemonsets and shipped to Elasticsearch.

```bash
# Tail logs for a specific service
kubectl -n momentum-prod logs -l app=booking-service --tail=100 -f

# Search for errors in the last hour (via Kibana or CLI)
curl -s "http://es-cluster:9200/logs-*/_search" \
  -H 'Content-Type: application/json' \
  -d '{
    "query": {
      "bool": {
        "must": [
          {"match": {"level": "error"}},
          {"match": {"service": "booking-service"}},
          {"range": {"@timestamp": {"gte": "now-1h"}}}
        ]
      }
    },
    "size": 20,
    "sort": [{"@timestamp": "desc"}]
  }' | jq '.hits.hits[]._source'
```

---

## Common Failure Modes and Recovery

### 1. Booking Service Out of Memory (OOMKilled)

**Symptoms**: OOMKilled pods, increasing restart count, booking failures.

**Diagnosis**:
```bash
kubectl -n momentum-prod describe pod booking-service-xxx | grep -A5 "Last State"
kubectl -n momentum-prod top pods -l app=booking-service --sort-by=memory
```

**Recovery**:
1. Increase memory limits in deployment spec (or HPA max if applicable).
2. Restart affected pods: `kubectl -n momentum-prod rollout restart deployment/booking-service`.
3. Check for memory leaks: review heap usage trends in Grafana.

**Prevention**: Set memory limits with 30% headroom. Configure `--max-old-space-size` in Node.js to match container limit minus 256 MB.

### 2. PostgreSQL Connection Pool Exhaustion

**Symptoms**: `FATAL: too many connections`, request timeouts, 503 responses.

**Diagnosis**:
```bash
kubectl -n momentum-prod exec -it deploy/pgbouncer -- \
  psql -p 6432 pgbouncer -c "SHOW POOLS;"
```

**Recovery**:
1. Kill idle-in-transaction connections:
   ```sql
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE state = 'idle in transaction'
     AND state_change < NOW() - INTERVAL '5 minutes';
   ```
2. Increase PgBouncer pool size if load is legitimate.
3. Restart services leaking connections.

**Prevention**: Set `idle_in_transaction_session_timeout = 30s` and `statement_timeout = 30s` in PostgreSQL.

### 3. Kafka Consumer Lag Spike

**Symptoms**: Elasticsearch results are stale, notifications are delayed.

**Diagnosis**:
```bash
kubectl -n momentum-prod exec -it deploy/kafka-0 -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --group search-indexer --describe

kubectl -n momentum-prod logs -l app=search-service --tail=100 | grep -i error
```

**Recovery**:
1. Scale consumer instances to match partition count.
2. Check for poison messages at the stuck offset.
3. If a poison message is found, move the offset past it or route to DLT.

**Prevention**: Implement DLT routing after 3 retries. Alert on consumer lag > 1,000.

### 4. Redis Cluster Node Failure

**Symptoms**: Increased latency, sporadic cache misses, connection errors.

**Diagnosis**:
```bash
kubectl -n momentum-prod exec -it redis-0 -- redis-cli cluster nodes | grep -v connected
kubectl -n momentum-prod exec -it redis-0 -- redis-cli cluster info | grep cluster_state
```

**Recovery**:
1. Verify automatic failover occurred (replica promoted to master).
2. If cluster state is `ok`, replace the failed node as a new replica.
3. If cluster state is `fail`, manual intervention required (see Redis Cluster Operations).

**Prevention**: Deploy across 3 AZs. Monitor node health with 10-second intervals.

### 5. Reservation Expiry Not Firing

**Symptoms**: Tickets stuck in `reserved` status beyond 7 minutes; inventory appears sold out.

**Diagnosis**:
```sql
SELECT COUNT(*), MIN(reserved_at) FROM tickets
WHERE status = 'reserved' AND reserved_at < NOW() - INTERVAL '7 minutes';
```

**Recovery**:
1. Re-enable keyspace notifications:
   ```bash
   kubectl -n momentum-prod exec -it redis-0 -- \
     redis-cli config set notify-keyspace-events Ex
   ```
2. Trigger manual sweep:
   ```bash
   kubectl -n momentum-prod exec -it deploy/booking-service -- \
     curl -XPOST localhost:3002/admin/sweep-stale-reservations
   ```
3. If sweep is also broken, manually release tickets:
   ```sql
   UPDATE tickets SET status = 'available', reserved_by = NULL,
     reserved_at = NULL, reservation_id = NULL, version = version + 1
   WHERE status = 'reserved' AND reserved_at < NOW() - INTERVAL '10 minutes';
   ```

**Prevention**: Alert if stale reservations > 100. Monitor sweep job execution frequency.

### 6. Elasticsearch Cluster Red

**Symptoms**: Search returns errors or partial results.

**Recovery**: See [Elasticsearch Reindexing > Cluster Recovery](#cluster-recovery).

**Prevention**: Monitor disk at 80%. Maintain 1 replica per shard. Use dedicated master nodes.

### 7. Stripe Webhook Delivery Failure

**Symptoms**: Payments charged but reservations not confirmed; users stuck on "Processing."

**Diagnosis**:
```bash
kubectl -n momentum-prod logs -l app=payment-service --tail=200 | grep webhook
```

**Recovery**:
1. Retry failed webhooks from the Stripe dashboard.
2. Run reconciliation job to match Stripe PaymentIntents with local records.
3. Manually publish `payments.completed` events for unmatched successful payments.

**Prevention**: Implement a reconciliation cron that checks for PaymentIntents with `status=succeeded` without a corresponding confirmed booking. Run every 5 minutes.

### 8. Hot Event Overwhelming System

**Symptoms**: High latency, 503 errors, queue depth growing rapidly.

**Recovery**:
1. Activate waiting room if not already active.
2. Scale booking service to max replicas.
3. Reduce admission rate in waiting room configuration.
4. Enable aggressive rate limiting.
5. If necessary, temporarily disable non-critical endpoints (search suggestions, user profile updates).

**Prevention**: Pre-scale before on-sale events. Load test with expected traffic patterns.

---

## Emergency Contacts

| Role | Contact Method | Escalation |
|------|---------------|------------|
| On-Call Engineer | PagerDuty rotation | Auto-escalates after 15 min (P1) |
| Engineering Lead | PagerDuty + direct | For all P1 incidents |
| Database Admin | PagerDuty | PostgreSQL/Redis emergencies |
| Infrastructure | PagerDuty | Kubernetes/networking issues |

---

## Related Documents

- [Architecture Overview](../architecture/architecture-overview.md)
- [Booking Consistency Strategy](../architecture/booking-consistency-strategy.md)
- [Search Architecture](../architecture/search-architecture.md)
- [Anti-Bot and Fairness](../architecture/anti-bot-and-fairness.md)
- [Scaling Assumptions](../architecture/scaling-assumptions.md)
