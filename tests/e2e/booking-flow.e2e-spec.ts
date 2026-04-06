/**
 * End-to-end test for the complete booking flow:
 * 1. List events
 * 2. Get event details
 * 3. Reserve tickets
 * 4. Create booking
 * 5. Verify tickets are booked
 */

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';

describe('Booking Flow (E2E)', () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  let eventId: string;
  let ticketIds: string[];
  let reservationId: string;

  it('should list published events', async () => {
    const response = await fetch(`${API_BASE}/events`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data).toBeDefined();
    expect(data.data.length).toBeGreaterThan(0);
    expect(data.pagination).toBeDefined();

    eventId = data.data[0].id;
  });

  it('should get event details with tickets', async () => {
    const response = await fetch(`${API_BASE}/events/${eventId}`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(eventId);
    expect(data.venue).toBeDefined();
    expect(data.tickets).toBeDefined();
    expect(data.tickets.length).toBeGreaterThan(0);
    expect(data.pricing.minPrice).toBeGreaterThan(0);
    expect(data.availability.available).toBeGreaterThan(0);

    // Pick 2 available tickets
    const availableTickets = data.tickets.filter((t: any) => t.status === 'available');
    ticketIds = availableTickets.slice(0, 2).map((t: any) => t.id);
    expect(ticketIds.length).toBe(2);
  });

  it('should reserve tickets', async () => {
    const response = await fetch(`${API_BASE}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tickets: ticketIds,
        user_id: userId,
        idempotency_key: `test-reserve-${Date.now()}`,
      }),
    });
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.reservation_id).toBeDefined();
    expect(data.tickets).toEqual(ticketIds);
    expect(data.ttl_seconds).toBe(420);
    expect(data.total_amount).toBeGreaterThan(0);

    reservationId = data.reservation_id;
  });

  it('should reject duplicate reservation for same tickets', async () => {
    const response = await fetch(`${API_BASE}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tickets: ticketIds,
        user_id: userId,
      }),
    });

    expect(response.status).toBe(409);
  });

  it('should create booking with payment', async () => {
    const response = await fetch(`${API_BASE}/booking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tickets: ticketIds,
        user_id: userId,
        reservation_id: reservationId,
        payment_details: { currency: 'brl' },
        idempotency_key: `test-booking-${Date.now()}`,
      }),
    });
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.booking_id).toBeDefined();
    expect(data.status).toBe('confirmed');
    expect(data.payment_status).toBe('succeeded');
    expect(data.total_amount).toBeGreaterThan(0);
  });

  it('should show tickets as booked after booking', async () => {
    const response = await fetch(`${API_BASE}/events/${eventId}`);
    const data = await response.json();

    for (const ticketId of ticketIds) {
      const ticket = data.tickets.find((t: any) => t.id === ticketId);
      expect(ticket.status).toBe('booked');
    }
  });
});
