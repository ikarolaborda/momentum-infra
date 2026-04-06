import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const searchDuration = new Trend('search_duration', true);

export const options = {
  scenarios: {
    search_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m', target: 200 },
        { duration: '2m', target: 500 },
        { duration: '1m', target: 200 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    search_duration: ['p(95)<500', 'p(99)<800'],
    errors: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3000';

const KEYWORDS = [
  'rock', 'festival', 'concert', 'anitta', 'caetano',
  'futebol', 'teatro', 'opera', 'rio', 'sao paulo',
  'rok', 'festval', 'conerto', 'maracana', 'lollapalooza',
];

export default function () {
  const keyword = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
  const res = http.get(`${BASE_URL}/search?keyword=${encodeURIComponent(keyword)}`);

  check(res, {
    'search status 200': (r) => r.status === 200,
    'search has results': (r) => JSON.parse(r.body).data !== undefined,
    'search under 500ms': (r) => r.timings.duration < 500,
  });

  errorRate.add(res.status !== 200);
  searchDuration.add(res.timings.duration);

  sleep(Math.random() * 1);
}
