# Momentum -- Anti-Bot and Fairness Strategy

## Overview

During high-demand on-sales, bots and automated tools can monopolize ticket inventory before legitimate users complete the purchase flow. This document defines Momentum's layered defense strategy to ensure fair access while maintaining system stability.

## Layered Strategy

```
Layer 1: Edge Protection (WAF / DDoS)
    │
    ▼
Layer 2: Rate Limiting (Per-IP, Per-User)
    │
    ▼
Layer 3: Waiting Room (Queue with Signed Tokens)
    │
    ▼
Layer 4: CAPTCHA / Turnstile (Suspicious Traffic)
    │
    ▼
Layer 5: Replay Protection (Request Signature Validation)
    │
    ▼
Layer 6: Booking Limits (Per-User Inventory Controls)
```

Each layer operates independently. A request must pass all layers to reach the booking service. Layers are additive -- disabling one layer does not compromise the others.

## Layer 1: Edge Protection

**Technology**: Cloudflare WAF / AWS Shield.

- **DDoS mitigation**: Volumetric attacks are absorbed at the edge before reaching Kubernetes.
- **IP reputation**: Known bot networks, data center IPs, and Tor exit nodes are flagged (not blocked by default -- flagged for Layer 4 CAPTCHA challenge).
- **Geo-blocking**: Optional per-event configuration for region-restricted sales.
- **TLS fingerprinting**: JA3/JA4 fingerprints are logged and forwarded to the API Gateway for anomaly detection.

## Layer 2: Rate Limiting

### Tiers

Rate limits are enforced at the API Gateway using `@nestjs/throttler` backed by Redis.

| Tier | Scope | Limit | Window | Applies To |
|------|-------|-------|--------|------------|
| **Global** | Per IP | 100 requests | 60 seconds | All endpoints |
| **Search** | Per IP | 30 requests | 10 seconds | `/api/v1/search`, `/api/v1/autocomplete` |
| **Reservation** | Per user | 5 requests | 60 seconds | `POST /api/v1/reservations` |
| **Payment** | Per user | 3 requests | 60 seconds | `POST /api/v1/payments` |
| **Auth** | Per IP | 10 requests | 300 seconds | `/api/v1/auth/login`, `/api/v1/auth/register` |
| **On-Sale Burst** | Per user | 2 requests | 30 seconds | `POST /api/v1/reservations` (during on-sale window) |

### Implementation

```typescript
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'global', ttl: 60000, limit: 100 },
        { name: 'search', ttl: 10000, limit: 30 },
        { name: 'reservation', ttl: 60000, limit: 5 },
      ],
      storage: new ThrottlerStorageRedisService(redisClient),
    }),
  ],
})
export class AppModule {}
```

### Rate Limit Headers

All responses include rate limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1712345678
Retry-After: 13  (only on 429 responses)
```

### Adaptive Rate Limiting

During declared on-sale events, the system automatically tightens rate limits:

- Reservation endpoint drops from 5/min to 2/30s per user.
- Search endpoint remains unchanged (users need to browse).
- The on-sale window is defined in the event configuration (`on_sale_start`, `on_sale_end`).

## Layer 3: Waiting Room

### Purpose

When demand exceeds system capacity for a specific event's on-sale, the waiting room queues users fairly before granting access to the booking flow.

### Architecture

```
User arrives at event page
    │
    ▼
┌──────────────────────────────┐
│  Is on-sale active AND       │
│  queue enabled for event?    │
│                              │
│  No  ──► Normal flow         │
│  Yes ──► Enter waiting room  │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Issue queue position token  │
│  (signed JWT)                │
│                              │
│  Token contains:             │
│  - user_id                   │
│  - event_id                  │
│  - bucket (randomized)       │
│  - issued_at                 │
│  - position_hash             │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Client polls /queue/status  │
│  every 5 seconds             │
│                              │
│  Response:                   │
│  - position: 4,521           │
│  - estimated_wait: "3 min"   │
│  - status: "waiting"         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  When bucket is admitted:    │
│  - status: "admitted"        │
│  - access_token (signed JWT) │
│  - expires_in: 600s (10min)  │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Client includes access      │
│  token in reservation        │
│  request header              │
│                              │
│  Gateway validates token     │
│  before forwarding to        │
│  booking service             │
└──────────────────────────────┘
```

### Signed JWT Queue Tokens

Queue tokens are signed JWTs with the following claims:

```json
{
  "sub": "user_abc123",
  "event_id": "evt_456",
  "bucket": 47,
  "iat": 1712345678,
  "exp": 1712346278,
  "type": "queue_position",
  "jti": "qt_unique_id"
}
```

- **Signed with RS256** using a private key known only to the API Gateway. Tokens cannot be forged.
- **`jti` (JWT ID)**: Unique identifier stored in Redis to prevent reuse after admission.
- **`exp`**: Queue position tokens expire after 10 minutes if not admitted (user must re-enter the queue).

### Access Tokens (Post-Admission)

When a user's bucket is admitted, they receive an access token:

```json
{
  "sub": "user_abc123",
  "event_id": "evt_456",
  "type": "queue_access",
  "iat": 1712346000,
  "exp": 1712346600,
  "jti": "qa_unique_id"
}
```

- **10-minute TTL**: Users have 10 minutes to complete their reservation after admission.
- **Single-use for reservation**: The `jti` is consumed when a reservation is created, preventing the same access token from being used for multiple reservation attempts.

## Layer 3a: Bucket-Randomized Ordering

### Problem

If the queue is ordered by arrival time (FIFO), users with lower network latency (closer to the data center) have a systematic advantage. This creates geographic unfairness.

### Solution

Users are assigned to **randomized buckets** rather than a strict FIFO queue:

1. When a user enters the waiting room, they are assigned a random bucket number (0-999).
2. Buckets are admitted in order (bucket 0 first, then 1, etc.).
3. Within a bucket, all users are admitted simultaneously.
4. Bucket assignment uses `SHA-256(user_id + event_id + salt)` modulo 1000, ensuring:
   - Deterministic assignment (same user always gets the same bucket for the same event).
   - Uniform distribution across buckets.
   - No advantage from entering the queue earlier (within the queue-open window).

```typescript
function assignBucket(userId: string, eventId: string, salt: string): number {
  const hash = crypto
    .createHash('sha256')
    .update(`${userId}:${eventId}:${salt}`)
    .digest('hex');
  return parseInt(hash.substring(0, 8), 16) % 1000;
}
```

### Bucket Admission Rate

The admission rate is configurable per event:

```typescript
interface QueueConfig {
  eventId: string;
  bucketsPerMinute: number;    // How many buckets to admit per minute
  usersPerBucket: number;      // Expected users per bucket (for capacity planning)
  maxConcurrentReservations: number; // System capacity limit
}
```

The admission controller monitors the booking service's active reservation count and adjusts the admission rate to keep concurrency below the configured maximum.

## Layer 4: CAPTCHA / Turnstile

### When Triggered

CAPTCHA challenges are not applied to all users -- only to traffic that exhibits suspicious patterns:

| Signal | Threshold | Action |
|--------|-----------|--------|
| Rate limit exceeded | 2+ violations in 5 minutes | CAPTCHA on next request |
| Data center IP | IP belongs to known cloud provider range | CAPTCHA on reservation |
| TLS fingerprint anomaly | JA3 hash matches known bot toolkit | CAPTCHA on reservation |
| Multiple accounts from same IP | 3+ distinct user sessions from same IP in 10 minutes | CAPTCHA on all sessions |
| Failed CAPTCHA | Previous CAPTCHA failed | Block for 5 minutes |

### Implementation

**Technology**: Cloudflare Turnstile (invisible by default, explicit challenge when suspicious).

```typescript
@Injectable()
export class CaptchaGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    if (!this.requiresCaptcha(request)) {
      return true;
    }

    const token = request.headers['x-turnstile-token'];
    if (!token) {
      throw new ForbiddenException({
        code: 'CAPTCHA_REQUIRED',
        message: 'CAPTCHA verification required',
        challengeUrl: this.getChallengeUrl(request),
      });
    }

    const valid = await this.verifyCaptchaToken(token);
    if (!valid) {
      await this.recordFailedCaptcha(request);
      throw new ForbiddenException({
        code: 'CAPTCHA_FAILED',
        message: 'CAPTCHA verification failed',
      });
    }

    return true;
  }

  private requiresCaptcha(request: Request): boolean {
    const ip = request.ip;
    const userId = request.user?.id;

    // Check Redis for suspicious flags
    // Flags are set by rate limiter, IP reputation check, etc.
    return this.suspicionService.isFlagged(ip, userId);
  }
}
```

## Layer 5: Replay Protection

### Request Signatures

Critical endpoints (reservation, payment) require a request signature to prevent replay attacks:

```
X-Request-Timestamp: 1712345678
X-Request-Nonce: nonce_abc123
X-Request-Signature: HMAC-SHA256(timestamp + nonce + body, user_session_key)
```

### Validation Rules

1. **Timestamp freshness**: `X-Request-Timestamp` must be within 30 seconds of server time. Requests outside this window are rejected.
2. **Nonce uniqueness**: `X-Request-Nonce` is stored in Redis with a 60-second TTL. Duplicate nonces are rejected.
3. **Signature validity**: The HMAC-SHA256 signature is verified using the user's session key (derived from the JWT).

```typescript
@Injectable()
export class ReplayProtectionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const timestamp = parseInt(request.headers['x-request-timestamp'], 10);
    const nonce = request.headers['x-request-nonce'];
    const signature = request.headers['x-request-signature'];

    // Timestamp freshness (30-second window)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 30) {
      throw new ForbiddenException('Request timestamp out of range');
    }

    // Nonce uniqueness
    const nonceKey = `nonce:${nonce}`;
    const isNew = await this.redis.set(nonceKey, '1', 'EX', 60, 'NX');
    if (!isNew) {
      throw new ForbiddenException('Duplicate request nonce');
    }

    // Signature verification
    const sessionKey = this.deriveSessionKey(request.user);
    const payload = `${timestamp}${nonce}${JSON.stringify(request.body)}`;
    const expected = crypto
      .createHmac('sha256', sessionKey)
      .update(payload)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new ForbiddenException('Invalid request signature');
    }

    return true;
  }
}
```

## Layer 6: Per-User and Per-IP Controls

### Per-User Booking Limits

| Control | Limit | Scope |
|---------|-------|-------|
| Tickets per event | 6 | Per user, per event |
| Active reservations | 2 | Per user, concurrent |
| Reservations per hour | 10 | Per user, sliding window |
| Events booked per day | 20 | Per user, calendar day |

These limits are enforced at the application level before attempting `SELECT FOR UPDATE`:

```typescript
async validateBookingLimits(userId: string, eventId: string, quantity: number): Promise<void> {
  // Check existing bookings for this event
  const existingTickets = await this.bookingRepository.count({
    where: { userId, eventId, status: In(['reserved', 'booked']) },
  });

  if (existingTickets + quantity > 6) {
    throw new ConflictException({
      code: 'TICKET_LIMIT_EXCEEDED',
      message: `Maximum 6 tickets per event. You already have ${existingTickets}.`,
    });
  }

  // Check concurrent reservations
  const activeReservations = await this.reservationRepository.count({
    where: { userId, status: 'pending_payment' },
  });

  if (activeReservations >= 2) {
    throw new ConflictException({
      code: 'MAX_ACTIVE_RESERVATIONS',
      message: 'Complete or cancel existing reservations before creating new ones.',
    });
  }
}
```

### Per-IP Controls

| Control | Limit | Action |
|---------|-------|--------|
| Unique user sessions | 5 per 10 minutes | Flag IP for CAPTCHA |
| Reservation attempts | 10 per 10 minutes | Hard block with 429 |
| Failed payment attempts | 5 per 30 minutes | Temporary IP block |

Per-IP controls use Redis sorted sets with sliding windows:

```typescript
async checkIpLimits(ip: string, action: string): Promise<void> {
  const key = `ip_limit:${action}:${ip}`;
  const now = Date.now();
  const windowMs = this.getWindowMs(action);

  // Remove entries outside the window
  await this.redis.zremrangebyscore(key, 0, now - windowMs);

  // Count entries in window
  const count = await this.redis.zcard(key);
  const limit = this.getLimit(action);

  if (count >= limit) {
    throw new TooManyRequestsException(`IP rate limit exceeded for ${action}`);
  }

  // Add current request
  await this.redis.zadd(key, now, `${now}:${crypto.randomUUID()}`);
  await this.redis.expire(key, Math.ceil(windowMs / 1000));
}
```

## Monitoring and Detection

### Real-Time Dashboard Metrics

- Requests per second by tier (global, search, reservation, payment).
- CAPTCHA challenge rate and pass/fail ratio.
- Waiting room queue depth and admission rate.
- Blocked IPs and users (count and reason breakdown).
- Reservation success rate (successful / attempted).

### Anomaly Detection Alerts

| Alert | Condition | Severity |
|-------|-----------|----------|
| Bot spike | CAPTCHA fail rate > 20% for 5 min | P2 |
| Queue overflow | Queue depth > 500,000 | P1 |
| Rate limit exhaustion | > 1,000 unique IPs hit rate limit in 1 min | P2 |
| Suspicious IP cluster | > 50 requests from same /24 subnet in 1 min | P3 |

## Configuration Per Event

Event organizers can configure fairness settings per event:

```typescript
interface EventFairnessConfig {
  waitingRoomEnabled: boolean;
  waitingRoomOpensAt: Date;        // When the queue opens (before on-sale)
  maxTicketsPerUser: number;       // Default: 6
  captchaOnReservation: boolean;   // Force CAPTCHA for all users (high-risk events)
  bucketsPerMinute: number;        // Admission rate
  reservationTtlSeconds: number;   // Default: 420 (7 minutes)
}
```

## Related Documents

- [ADR-0004: Concurrency Strategy](../adr/0004-concurrency-strategy.md)
- [Architecture Overview](./architecture-overview.md)
- [Booking Consistency Strategy](./booking-consistency-strategy.md)
- [Scaling Assumptions](./scaling-assumptions.md)
