import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.AUTH_REQUIRED = 'true';
process.env.OIDC_ISSUER = 'https://auth.example.test/application/o/operation-backend';
process.env.OIDC_AUDIENCE = 'operation-backend';
const { buildApp } = await import('../src/app.js');
const app = buildApp();
after(async () => app.close());

test('OIDC configuration rejects an operational request without a bearer token', async () => {
  const response = await app.inject({ method: 'GET', url: '/v1/availability?route_id=r1&date=2030-01-01' });
  assert.equal(response.statusCode, 401);
});

test('health remains public when OIDC is configured', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
});
