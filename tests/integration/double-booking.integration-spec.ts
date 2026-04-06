/**
 * CRITICAL CONCURRENCY TEST
 *
 * This test proves that two concurrent users cannot book the same ticket/seat.
 * It simulates a race condition where multiple users try to reserve the same ticket simultaneously.
 *
 * Expected behavior:
 * - Only ONE user should successfully reserve the ticket
 * - All other users should receive a 409 Conflict response
 * - The ticket should be reserved by exactly one user
 */

const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://localhost:3002';
const EVENT_SERVICE_URL = process.env.EVENT_SERVICE_URL || 'http://localhost:3001';

describe('Double Booking Prevention (Concurrency)', () => {
  let targetTicketId: string;
  let eventId: string;

  beforeAll(async () => {
    // Get an available ticket
    const eventsResponse = await fetch(`${EVENT_SERVICE_URL}/events`);
    const eventsData = await eventsResponse.json();
    expect(eventsData.data.length).toBeGreaterThan(0);

    eventId = eventsData.data[0].id;

    const eventResponse = await fetch(`${EVENT_SERVICE_URL}/events/${eventId}`);
    const eventData = await eventResponse.json();

    const available = eventData.tickets.filter((t: any) => t.status === 'available');
    expect(available.length).toBeGreaterThan(0);

    targetTicketId = available[0].id;
  });

  it('should prevent double-booking when 10 concurrent users try to reserve the same ticket', async () => {
    const CONCURRENT_USERS = 10;

    // Create concurrent reservation requests for the SAME ticket
    const requests = Array.from({ length: CONCURRENT_USERS }, (_, i) =>
      fetch(`${BOOKING_SERVICE_URL}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tickets: [targetTicketId],
          user_id: `00000000-0000-0000-0000-00000000000${i + 1}`.slice(0, 36),
        }),
      }).then(async (res) => ({
        status: res.status,
        body: await res.json(),
        userId: i + 1,
      })),
    );

    // Fire all requests simultaneously
    const results = await Promise.all(requests);

    // Count successes and failures
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    console.log(`Results: ${successes.length} successes, ${conflicts.length} conflicts`);
    successes.forEach((s) =>
      console.log(`  User ${s.userId} succeeded: reservation=${s.body.reservation_id}`),
    );

    // CRITICAL ASSERTION: Exactly ONE user should succeed
    expect(successes.length).toBe(1);

    // All others should get 409 Conflict
    expect(conflicts.length).toBe(CONCURRENT_USERS - 1);
  });

  it('should prevent double-booking when same user sends duplicate requests', async () => {
    // Get another available ticket
    const eventResponse = await fetch(`${EVENT_SERVICE_URL}/events/${eventId}`);
    const eventData = await eventResponse.json();
    const available = eventData.tickets.filter((t: any) => t.status === 'available');

    if (available.length === 0) {
      console.log('No more available tickets, skipping test');
      return;
    }

    const ticketId = available[0].id;
    const userId = '00000000-0000-0000-0000-000000000001';
    const idempotencyKey = `idem-${Date.now()}`;

    // Send the same request twice concurrently with the same idempotency key
    const [result1, result2] = await Promise.all([
      fetch(`${BOOKING_SERVICE_URL}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tickets: [ticketId],
          user_id: userId,
          idempotency_key: idempotencyKey,
        }),
      }).then(async (res) => ({ status: res.status, body: await res.json() })),
      fetch(`${BOOKING_SERVICE_URL}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tickets: [ticketId],
          user_id: userId,
          idempotency_key: idempotencyKey,
        }),
      }).then(async (res) => ({ status: res.status, body: await res.json() })),
    ]);

    // One should succeed, one should get conflict or return same result (idempotency)
    const statuses = [result1.status, result2.status].sort();
    const hasSuccess = statuses.includes(201);
    expect(hasSuccess).toBe(true);

    // If both succeed, they must return the same reservation_id (idempotency)
    if (result1.status === 201 && result2.status === 201) {
      expect(result1.body.reservation_id).toBe(result2.body.reservation_id);
    }
  });
});
