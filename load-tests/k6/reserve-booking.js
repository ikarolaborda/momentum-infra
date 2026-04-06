import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

const errorRate = new Rate('errors');
const reserveSuccess = new Counter('reserve_success');
const reserveConflict = new Counter('reserve_conflict');
const bookingSuccess = new Counter('booking_success');

export const options = {
  scenarios: {
    booking_flow: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 100 },
        { duration: '2m', target: 200 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    errors: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3000';

export default function () {
  // 1. Get events and pick a random ticket
  const eventsRes = http.get(`${BASE_URL}/events?page=1&limit=5`);
  if (eventsRes.status !== 200) {
    errorRate.add(1);
    return;
  }

  const events = JSON.parse(eventsRes.body);
  if (!events.data || events.data.length === 0) return;

  const event = events.data[Math.floor(Math.random() * events.data.length)];
  const detailRes = http.get(`${BASE_URL}/events/${event.id}`);
  if (detailRes.status !== 200) return;

  const detail = JSON.parse(detailRes.body);
  const available = detail.tickets.filter((t) => t.status === 'available');
  if (available.length === 0) return;

  const ticket = available[Math.floor(Math.random() * available.length)];
  const userId = `test-user-${__VU}-${__ITER}`;

  // 2. Reserve
  const reserveRes = http.post(
    `${BASE_URL}/reserve`,
    JSON.stringify({
      tickets: [ticket.id],
      user_id: '00000000-0000-0000-0000-000000000001',
      idempotency_key: `k6-${userId}-${Date.now()}`,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (reserveRes.status === 201) {
    reserveSuccess.add(1);

    const reservation = JSON.parse(reserveRes.body);

    // 3. Book
    const bookRes = http.post(
      `${BASE_URL}/booking`,
      JSON.stringify({
        tickets: [ticket.id],
        user_id: '00000000-0000-0000-0000-000000000001',
        reservation_id: reservation.reservation_id,
        payment_details: { currency: 'brl' },
        idempotency_key: `k6-booking-${userId}-${Date.now()}`,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    if (bookRes.status === 201) {
      bookingSuccess.add(1);
    }
  } else if (reserveRes.status === 409) {
    reserveConflict.add(1);
  } else {
    errorRate.add(1);
  }

  sleep(Math.random() * 3);
}
