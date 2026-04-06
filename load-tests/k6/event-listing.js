import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const eventListDuration = new Trend('event_list_duration', true);

export const options = {
  scenarios: {
    event_listing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 500 },
        { duration: '2m', target: 1000 },
        { duration: '1m', target: 500 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    errors: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3000';

export default function () {
  // List events
  const listRes = http.get(`${BASE_URL}/events?page=1&limit=20`);
  check(listRes, {
    'list events status 200': (r) => r.status === 200,
    'list events has data': (r) => JSON.parse(r.body).data.length > 0,
  });
  errorRate.add(listRes.status !== 200);
  eventListDuration.add(listRes.timings.duration);

  // Get event detail
  const events = JSON.parse(listRes.body);
  if (events.data && events.data.length > 0) {
    const eventId = events.data[Math.floor(Math.random() * events.data.length)].id;
    const detailRes = http.get(`${BASE_URL}/events/${eventId}`);
    check(detailRes, {
      'event detail status 200': (r) => r.status === 200,
      'event detail has tickets': (r) => JSON.parse(r.body).tickets !== undefined,
    });
    errorRate.add(detailRes.status !== 200);
  }

  sleep(Math.random() * 2);
}
