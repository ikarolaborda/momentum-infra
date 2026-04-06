import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const reserveAttempts = new Counter('reserve_attempts');
const reserveSuccesses = new Counter('reserve_successes');
const reserveConflicts = new Counter('reserve_conflicts');
const reserveLatency = new Trend('reserve_latency', true);

/**
 * Hot Event Surge Test
 * Simulates a massive spike when a popular event goes on sale.
 * Tests the system's ability to handle extreme concurrency
 * while preventing double-booking.
 */
export const options = {
  scenarios: {
    hot_event_surge: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 500 },   // Sudden spike
        { duration: '30s', target: 2000 },   // Peak load
        { duration: '1m', target: 2000 },    // Sustained peak
        { duration: '30s', target: 500 },    // Gradual decrease
        { duration: '10s', target: 0 },      // Cool down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    errors: ['rate<0.10'],
  },
};

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3000';
const EVENT_ID = __ENV.HOT_EVENT_ID || '20000000-0000-0000-0000-000000000001';

export default function () {
  // Get event details to find available tickets
  const detailRes = http.get(`${BASE_URL}/events/${EVENT_ID}`);
  if (detailRes.status !== 200) {
    errorRate.add(1);
    return;
  }

  const detail = JSON.parse(detailRes.body);
  const available = detail.tickets.filter((t) => t.status === 'available');

  if (available.length === 0) {
    sleep(1);
    return;
  }

  // Try to reserve a random available ticket
  const ticket = available[Math.floor(Math.random() * available.length)];
  reserveAttempts.add(1);

  const start = Date.now();
  const reserveRes = http.post(
    `${BASE_URL}/reserve`,
    JSON.stringify({
      tickets: [ticket.id],
      user_id: '00000000-0000-0000-0000-000000000001',
      idempotency_key: `surge-${__VU}-${__ITER}-${Date.now()}`,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  reserveLatency.add(Date.now() - start);

  if (reserveRes.status === 201) {
    reserveSuccesses.add(1);
  } else if (reserveRes.status === 409) {
    reserveConflicts.add(1);
  } else {
    errorRate.add(1);
  }

  sleep(Math.random() * 0.5);
}
