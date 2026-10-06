import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';

const app = buildApp();

after(async () => app.close());

test('GET /api/health reports service health', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok', commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null });
});

test('GET /api/health names the commit Railway built from', async () => {
  const previous = process.env.RAILWAY_GIT_COMMIT_SHA;
  process.env.RAILWAY_GIT_COMMIT_SHA = '3be6b2c';
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).json().commit, '3be6b2c');
  } finally {
    if (previous === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA; else process.env.RAILWAY_GIT_COMMIT_SHA = previous;
  }
});

test('a browser may preflight every method the API uses', async () => {
  const previous = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://rsvn.example.com';
  const cors = buildApp();
  try {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await cors.inject({ method: 'OPTIONS', url: '/v1/bookings/x', headers: { origin: 'https://rsvn.example.com', 'access-control-request-method': method } });
      assert.equal(response.statusCode, 204, `${method} preflight`);
      assert.match(String(response.headers['access-control-allow-methods']), new RegExp(`\\b${method}\\b`), `${method} is allowed`);
    }
    const stranger = await cors.inject({ method: 'OPTIONS', url: '/v1/bookings/x', headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'PATCH' } });
    assert.equal(stranger.headers['access-control-allow-origin'], undefined, 'an origin not in CORS_ORIGIN gets no grant');
  } finally {
    await cors.close();
    if (previous === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = previous;
  }
});

test('GET / serves the web page', async () => {
  const response = await app.inject({ method: 'GET', url: '/' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] ?? '', /text\/html/);
});
