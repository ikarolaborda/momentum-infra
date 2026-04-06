# ADR-0004: Concurrency and Double-Booking Prevention Strategy

| Field       | Value                        |
|-------------|------------------------------|
| **Status**  | Accepted                     |
| **Date**    | 2026-04-06                   |
| **Deciders**| Platform Engineering Team    |

## Context

Momentum sells tickets to events with fixed inventory. During a peak on-sale, thousands of users simultaneously attempt to reserve the same seats. The system must guarantee:

1. **No double-booking** -- a single ticket must never be sold to more than one user.
2. **No deadlocks** -- concurrent reservation attempts must not block each other indefinitely.
3. **Reservation expiry** -- unpaid reservations must be released back to inventory automatically.
4. **Idempotency** -- network retries and client-side double-clicks must not create duplicate reservations or charges.
5. **Fairness** -- users who arrive first should have priority, but the system must not serialize all requests through a single bottleneck.
6. **Consistency under failure** -- if the application crashes mid-transaction, the system must converge to a consistent state.

## Decision

Implement a multi-layered concurrency control strategy combining PostgreSQL pessimistic locking, a Redis-backed reservation state machine with TTL-based expiry, idempotency keys, and database-level unique constraints.

## Strategy Components

### 1. Pessimistic Locking: SELECT FOR UPDATE SKIP LOCKED

When a user requests tickets, the booking service acquires locks on available ticket rows:

```sql
BEGIN;

SELECT id, seat_number, section, price
FROM tickets
WHERE event_id = $1
  AND status = 'available'
  AND section = $2
ORDER BY seat_number
LIMIT $3
FOR UPDATE SKIP LOCKED;

-- If sufficient rows returned, update status
UPDATE tickets
SET status = 'reserved',
    reserved_by = $4,
    reserved_at = NOW(),
    version = version + 1
WHERE id = ANY($5);

COMMIT;
```

**Why `SKIP LOCKED`:**

- Standard `FOR UPDATE` blocks concurrent transactions until the lock is released, creating contention and potential deadlocks.
- `SKIP LOCKED` causes concurrent transactions to skip rows that are already locked, immediately moving to the next available ticket.
- This transforms a serialized bottleneck into a parallel operation: 100 concurrent requests each grab different available tickets without waiting.
- If fewer tickets are returned than requested (because others are locked), the service can either retry or inform the user that fewer seats are available.

### 2. Reservation State Machine

Each ticket follows a strict state machine:

```
                    ┌──────────────┐
                    │              │
            ┌──────►  available   ◄──────────┐
            │       │              │          │
            │       └──────┬───────┘          │
            │              │                  │
            │         reserve()               │
            │              │                  │
            │       ┌──────▼───────┐          │
            │       │              │          │
  expire()  │       │   reserved   │          │  expire()
  (TTL)     │       │              │          │  (backup)
            │       └──────┬───────┘          │
            │              │                  │
            │        confirm()                │
            │              │                  │
            │       ┌──────▼───────┐          │
            │       │              │          │
            │       │    booked    ├──────────┘
            │       │              │  refund()
            │       └──────────────┘
            │
            │  (payment timeout or
            │   explicit cancel)
            └──────────────────
```

Valid transitions:

| From        | To          | Trigger                         |
|-------------|-------------|---------------------------------|
| `available` | `reserved`  | User initiates reservation      |
| `reserved`  | `booked`    | Payment confirmed (Stripe webhook) |
| `reserved`  | `available` | TTL expires or user cancels     |
| `booked`    | `available` | Refund processed                |

Invalid transitions (enforced in application code and database constraints):

- `available` -> `booked` (must go through `reserved`)
- `booked` -> `reserved` (no re-reservation of booked tickets)
- `reserved` -> `reserved` (no re-reservation by a different user while reserved)

### 3. Redis TTL for Reservation Expiry

When a reservation is created, a Redis key is set with a 7-minute TTL:

```
Key:    reservation:{reservation_id}
Value:  { user_id, ticket_ids, event_id, created_at }
TTL:    420 seconds (7 minutes)
```

**Why 7 minutes:**

- Allows sufficient time for users to complete payment (typical checkout: 2-4 minutes).
- Short enough to return inventory quickly during high-demand on-sales.
- Aligns with industry norms (Ticketmaster uses 8-10 minutes; we optimize for faster turnover).

**Expiry detection** uses two complementary mechanisms:

1. **Redis keyspace notifications** -- the booking service subscribes to `__keyevent@0__:expired` events. When a reservation key expires, the handler releases the tickets back to `available` status in PostgreSQL.

2. **Scheduled backup job** -- a cron job runs every 60 seconds, querying for tickets with `status = 'reserved'` and `reserved_at < NOW() - INTERVAL '7 minutes'`. This catches expirations missed due to Redis notification failures (e.g., network partition, service restart during expiry).

```typescript
// Keyspace notification handler
@Injectable()
export class ReservationExpiryListener {
  @OnEvent('redis.keyspace.expired')
  async handleExpiry(key: string): Promise<void> {
    const reservationId = this.extractReservationId(key);
    if (!reservationId) return;

    await this.bookingService.releaseReservation(reservationId, 'ttl_expired');
  }
}

// Backup job
@Cron('*/60 * * * * *')
async releaseStaleReservations(): Promise<void> {
  const stale = await this.ticketRepository.find({
    where: {
      status: 'reserved',
      reservedAt: LessThan(new Date(Date.now() - 7 * 60 * 1000)),
    },
  });

  for (const ticket of stale) {
    await this.bookingService.releaseReservation(ticket.reservationId, 'backup_sweep');
  }
}
```

### 4. Idempotency Keys

Both the reserve and booking endpoints require an `Idempotency-Key` header:

```
POST /api/v1/reservations
Idempotency-Key: usr_abc123_evt_456_1712345678
```

The idempotency key is stored in Redis with the response:

```
Key:    idempotency:{key}
Value:  { status_code, body, created_at }
TTL:    3600 seconds (1 hour)
```

**Behavior:**

1. First request with a given key: process normally, store result.
2. Subsequent requests with the same key: return the stored result without re-processing.
3. Concurrent requests with the same key: the first request acquires a Redis lock (`SETNX`); concurrent requests wait briefly, then return the stored result or a `409 Conflict`.

**Key format convention:** `{user_id}_{resource}_{timestamp}` -- ensures uniqueness while being debuggable.

### 5. Unique Constraint on booking_items.ticket_id

The database enforces a unique constraint as the final safety net:

```sql
CREATE TABLE booking_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id),
    ticket_id UUID NOT NULL REFERENCES tickets(id),
    price DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_booking_items_ticket_id UNIQUE (ticket_id)
);
```

If all other mechanisms fail (race condition, bug in application logic), the database rejects the duplicate assignment with a unique constraint violation. The application catches this and returns a `409 Conflict` to the user.

### 6. Optimistic Concurrency via Version Column

The `tickets` table includes a `version` column for optimistic concurrency control:

```sql
ALTER TABLE tickets ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Update with optimistic lock
UPDATE tickets
SET status = 'booked',
    version = version + 1
WHERE id = $1
  AND version = $2;  -- Must match the version read during reservation
```

If the version has changed between the read and the write (indicating another transaction modified the row), zero rows are updated, and the application retries or returns an error.

This serves as a **fallback** for operations that do not use `SELECT FOR UPDATE` (e.g., background jobs, webhook handlers) where pessimistic locking is not practical.

## Defense in Depth Summary

```
Layer 1: Idempotency Key (Redis)
  └─ Prevents duplicate processing of retried requests

Layer 2: SELECT FOR UPDATE SKIP LOCKED (PostgreSQL)
  └─ Prevents concurrent transactions from locking the same ticket

Layer 3: State Machine Validation (Application)
  └─ Prevents invalid state transitions

Layer 4: Version Column (PostgreSQL)
  └─ Detects concurrent modifications in non-locked paths

Layer 5: UNIQUE Constraint on booking_items.ticket_id (PostgreSQL)
  └─ Absolute database-level guarantee against double-booking

Layer 6: Redis TTL + Backup Job (Redis + PostgreSQL)
  └─ Ensures unreserved tickets are released back to inventory
```

## Consequences

### Positive

- **Zero double-bookings** -- the layered approach provides defense in depth; no single point of failure can result in a double-booking.
- **High concurrency** -- `SKIP LOCKED` enables parallel ticket acquisition without serialization or deadlocks.
- **Automatic recovery** -- Redis TTL + backup job ensures inventory is never permanently locked by abandoned reservations.
- **Idempotent APIs** -- safe for client retries, webhook redelivery, and network instability.
- **Auditability** -- every state transition is recorded with a reason (`user_reserved`, `payment_confirmed`, `ttl_expired`, `backup_sweep`, `refund_processed`).

### Negative

- **Complexity** -- six layers of concurrency control increase code complexity and require thorough testing.
- **Redis dependency for expiry** -- if Redis is unavailable, the backup job handles expiry with up to 60-second delay.
- **7-minute reservation window** -- during extreme demand, 7 minutes of locked inventory can cause perceived sell-outs. This is a deliberate trade-off favoring user experience over inventory velocity.

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Redis keyspace notification missed | Backup sweep job runs every 60 seconds; reconciliation alerts if tickets remain reserved beyond 10 minutes |
| Database connection pool exhaustion during peak | Connection pooling via PgBouncer; `SKIP LOCKED` minimizes transaction hold times |
| Idempotency key collision | Key format includes user ID and timestamp; collision probability is negligible |
| Version column drift | Version is incremented on every state change; logged for debugging |
| Backup job processing stale reservation that was just paid | `releaseReservation()` checks current status before modifying; `version` column prevents stale writes |

## References

- PostgreSQL SKIP LOCKED: https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
- Redis Keyspace Notifications: https://redis.io/docs/manual/keyspace-notifications/
- Idempotency Patterns: https://stripe.com/docs/api/idempotent_requests
