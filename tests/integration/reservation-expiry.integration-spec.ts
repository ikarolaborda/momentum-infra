/**
 * Tests for reservation expiry behavior:
 * - Reservations should expire after TTL
 * - Expired reservations should release tickets back to available
 */

const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://localhost:3002';
const EVENT_SERVICE_URL = process.env.EVENT_SERVICE_URL || 'http://localhost:3001';

describe('Reservation Expiry', () => {
  it('should create a reservation with correct TTL', async () => {
    const eventsRes = await fetch(`${EVENT_SERVICE_URL}/events`);
    const events = await eventsRes.json();
    const eventId = events.data[0].id;

    const eventRes = await fetch(`${EVENT_SERVICE_URL}/events/${eventId}`);
    const event = await eventRes.json();
    const available = event.tickets.filter((t: any) => t.status === 'available');

    if (available.length === 0) {
      console.log('No available tickets, skipping');
      return;
    }

    const ticketId = available[available.length - 1].id;

    const response = await fetch(`${BOOKING_SERVICE_URL}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tickets: [ticketId],
        user_id: '00000000-0000-0000-0000-000000000003',
      }),
    });
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.ttl_seconds).toBe(420); // 7 minutes
    expect(data.expires_at).toBeDefined();

    const expiresAt = new Date(data.expires_at);
    const now = new Date();
    const diffSeconds = (expiresAt.getTime() - now.getTime()) / 1000;

    // Should be approximately 420 seconds in the future (with some tolerance)
    expect(diffSeconds).toBeGreaterThan(400);
    expect(diffSeconds).toBeLessThan(440);
  });
});
