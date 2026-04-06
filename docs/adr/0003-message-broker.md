# ADR-0003: Message Broker Selection -- Apache Kafka

| Field       | Value                        |
|-------------|------------------------------|
| **Status**  | Accepted                     |
| **Date**    | 2026-04-06                   |
| **Deciders**| Platform Engineering Team    |

## Context

Momentum's microservice architecture requires asynchronous communication for:

- **Event propagation** -- when an event is created or updated, multiple downstream services (search indexer, notification service, analytics) must be informed.
- **Booking state changes** -- reservation created, payment confirmed, ticket issued, reservation expired. Multiple consumers need these events.
- **Audit trail** -- all state transitions must be durably recorded for compliance and debugging.
- **Decoupling** -- services must not directly depend on each other's availability; a search indexer outage must not block booking operations.
- **Scale** -- the system must handle burst traffic during on-sales where thousands of bookings occur per second.
- **Ordering guarantees** -- booking events for the same ticket must be processed in order to prevent state machine violations.

## Candidates Evaluated

### 1. Apache Kafka

- **Durability**: Messages are persisted to disk with configurable replication factor (min 3 for production). Messages are retained for days/weeks, enabling replay.
- **Throughput**: Designed for millions of messages per second per cluster. Partitioned topics enable horizontal scaling of both producers and consumers.
- **NestJS integration**: Native `@nestjs/microservices` Kafka transport. Producers and consumers are configured via decorators and module registration.
- **Topic-based routing**: Events are published to topics (e.g., `events.created`, `bookings.reserved`, `bookings.confirmed`). Consumers subscribe to specific topics.
- **Consumer groups**: Multiple instances of a service form a consumer group; Kafka assigns partitions across instances, enabling horizontal scaling with exactly-once-per-group delivery.
- **Ordering**: Messages with the same partition key (e.g., `event_id` or `ticket_id`) are guaranteed to be delivered in order within a partition.
- **Replay**: Consumers can reset their offset to reprocess historical messages -- critical for rebuilding search indexes or replaying failed processing.

### 2. RabbitMQ

- **Strengths**: Mature, well-understood. Excellent for task queue patterns (distribute work across workers). Flexible routing via exchanges and bindings. Lower operational complexity for small deployments.
- **Weaknesses**:
  - **Not designed for event streaming** -- messages are deleted after acknowledgment; no replay capability without Dead Letter Exchanges (which are not equivalent).
  - **Fan-out limitations** -- while topic exchanges support fan-out, each consumer queue holds a copy of the message, increasing memory pressure at scale.
  - **Ordering** -- only guaranteed within a single queue; partitioning requires manual shard management.
  - **Throughput ceiling** -- single-node broker becomes a bottleneck; clustering adds complexity without Kafka's partition-based parallelism.
  - **NestJS transport** -- supported but less feature-rich than the Kafka transport for streaming patterns.

### 3. Redis Streams

- **Strengths**: Already in the stack (Redis is used for caching and locks). Consumer group support. Simple to set up. Low latency.
- **Weaknesses**:
  - **Durability** -- Redis is primarily in-memory; persistence (RDB/AOF) adds latency and is less reliable than Kafka's replicated commit log for critical event streams.
  - **Scale** -- single Redis instance or cluster has lower throughput ceiling than a dedicated Kafka cluster for high-volume streaming.
  - **No built-in schema registry** -- no equivalent to Kafka's schema registry for evolving message contracts.
  - **Operational risk** -- overloading Redis with streaming workloads could degrade caching and locking performance.
  - **NestJS transport** -- Redis transport exists but is designed for request-response patterns, not streaming.

## Decision

**Adopt Apache Kafka as the primary message broker for all asynchronous event propagation in Momentum.**

Redis Streams may be used for lightweight, non-critical pub/sub within a single service boundary (e.g., internal cache invalidation signals), but all cross-service event communication flows through Kafka.

## Rationale

### Durability and Replay

Kafka's replicated commit log ensures that no event is lost, even during consumer outages. When the search indexer is down for maintenance, events accumulate in the topic and are processed when the consumer restarts. This replay capability is also essential for:

- Rebuilding Elasticsearch indexes from scratch by replaying `events.*` topics.
- Recovering from a consumer bug by resetting offsets and reprocessing.
- Auditing booking state transitions by reading the `bookings.*` topics.

RabbitMQ deletes messages after acknowledgment, making these scenarios impossible without additional infrastructure (e.g., storing messages in a database).

### NestJS Native Transport

NestJS provides first-class Kafka transport:

```typescript
// Producer -- emitting an event
@Injectable()
export class EventService {
  constructor(@Inject('KAFKA_SERVICE') private kafka: ClientKafka) {}

  async publishEventCreated(event: EventEntity): Promise<void> {
    this.kafka.emit('events.created', {
      key: event.id,
      value: JSON.stringify(event),
    });
  }
}

// Consumer -- handling an event
@Controller()
export class SearchIndexerController {
  @EventPattern('events.created')
  async handleEventCreated(@Payload() data: EventCreatedPayload): Promise<void> {
    await this.searchService.indexEvent(data);
  }
}
```

This decorator-based approach is consistent with the rest of the NestJS architecture and requires minimal boilerplate.

### Topic-Based Event Propagation

Events are organized into topics by domain and action:

| Topic                    | Producer         | Consumers                          |
|--------------------------|------------------|------------------------------------|
| `events.created`         | Event Service    | Search Indexer, Notification, Analytics |
| `events.updated`         | Event Service    | Search Indexer, Analytics          |
| `bookings.reserved`      | Booking Service  | Analytics, Monitoring              |
| `bookings.confirmed`     | Booking Service  | Notification, Analytics, Accounting |
| `bookings.expired`       | Booking Service  | Analytics, Monitoring              |
| `payments.completed`     | Payment Service  | Booking Service, Notification      |
| `payments.failed`        | Payment Service  | Booking Service, Notification      |

### Consumer Groups for Scaling

Each service forms a consumer group:

```
Topic: events.created (6 partitions)
├── Consumer Group: search-indexer (3 instances)
│   ├── Instance 1 → Partitions 0, 1
│   ├── Instance 2 → Partitions 2, 3
│   └── Instance 3 → Partitions 4, 5
├── Consumer Group: notification-service (2 instances)
│   ├── Instance 1 → Partitions 0, 1, 2
│   └── Instance 2 → Partitions 3, 4, 5
└── Consumer Group: analytics-service (1 instance)
    └── Instance 1 → Partitions 0-5
```

Each consumer group independently tracks its offset, enabling:
- Independent scaling per consumer service.
- Independent failure recovery -- one consumer group's lag does not affect others.
- Independent deployment -- consumers can be upgraded without affecting producers.

### Ordering Guarantees

Partition keys ensure ordering where it matters:

- `bookings.*` topics use `ticket_id` as the partition key, ensuring all state transitions for a single ticket are processed in order.
- `events.*` topics use `event_id` as the partition key, ensuring updates to the same event are indexed in order.

### Why Not RabbitMQ?

RabbitMQ excels at task distribution (round-robin to workers) but Momentum's primary need is event propagation (fan-out to multiple independent consumers with replay). Kafka's commit log model is architecturally aligned with this requirement. RabbitMQ would require additional patterns (e.g., Shovel, Federation, external event stores) to achieve equivalent durability and replay.

### Why Not Redis Streams?

Redis is already under heavy load for caching, distributed locks, and reservation TTLs. Adding high-volume event streaming to the same cluster introduces operational risk. Redis Streams also lack Kafka's durability guarantees -- a Redis cluster failure could result in lost events, which is unacceptable for booking state transitions.

## Consequences

### Positive

- Durable, replayable event log for all cross-service communication.
- Native NestJS integration reduces development effort.
- Consumer groups enable independent scaling per service.
- Partition keys guarantee ordering for critical booking flows.
- Retention policies enable event replay for index rebuilding and debugging.

### Negative

- Kafka is operationally complex (ZooKeeper or KRaft coordination, broker configuration, topic management).
- Additional infrastructure cost (minimum 3-broker cluster for production).
- Higher latency than Redis Streams (typically 5-15ms vs 1-3ms) -- acceptable for async flows.
- Requires schema evolution strategy (Avro/JSON Schema with registry) to prevent producer-consumer contract breakage.

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Kafka cluster outage | Multi-AZ deployment, replication factor 3, ISR min 2 |
| Consumer lag during peak | Auto-scaling consumer groups via KEDA; partition count sized for peak throughput |
| Message deserialization failure | Dead letter topic per consumer group; alerting on DLT message count |
| Schema evolution breaking consumers | JSON Schema registry; backward-compatible changes only; CI validation |
| Kafka operational complexity | Managed Kafka service (AWS MSK, Confluent Cloud) for production; local Docker for development |

## References

- NestJS Kafka Transport: https://docs.nestjs.com/microservices/kafka
- Apache Kafka Documentation: https://kafka.apache.org/documentation/
- Kafka vs RabbitMQ: https://www.confluent.io/kafka-vs-rabbitmq/
