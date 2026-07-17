/**
 * Integration tests for the health endpoint and app setup
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('Health Endpoint', () => {
  const app = createApp();

  it('GET /api/v1/health returns 200 with status ok', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  it('health response timestamp is valid ISO 8601', async () => {
    const res = await request(app).get('/api/v1/health');
    const date = new Date(res.body.timestamp);
    expect(date.toISOString()).toBe(res.body.timestamp);
  });

  it('does not require authentication', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
  });

  it('returns JSON content type', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('App Security Headers', () => {
  const app = createApp();

  it('sets helmet security headers', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});
