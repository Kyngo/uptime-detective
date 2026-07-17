/**
 * Integration tests for auth routes (login, me, password change)
 * Uses an in-memory SQLite database for isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import express from 'express';
import { vi } from 'vitest';

// We need to override getDb to return our test database
let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
}));

import { authRouter } from '../../src/routes/auth.js';
import { signToken } from '../../src/middleware/auth.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRouter);
  return app;
}

describe('Auth Routes', () => {
  let app: express.Express;
  let adminToken: string;

  beforeAll(async () => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');

    // Create users table
    testDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        api_token TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Insert test user
    const hash = await bcrypt.hash('password123', 12);
    testDb.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run('admin', hash, 'admin');

    app = createTestApp();
    adminToken = signToken({ id: 1, username: 'admin', role: 'admin' });
  });

  afterAll(() => { testDb.close(); });

  describe('POST /api/v1/auth/login', () => {
    it('returns token on valid credentials', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'admin', password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.username).toBe('admin');
      expect(res.body.user.role).toBe('admin');
    });

    it('returns 401 for wrong password', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'admin', password: 'wrong' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });

    it('returns 401 for non-existent user', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'nobody', password: 'pass' });

      expect(res.status).toBe(401);
    });

    it('returns 400 for missing fields', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'admin' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('returns current user info with valid token', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.username).toBe('admin');
      expect(res.body.role).toBe('admin');
    });

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/v1/auth/password', () => {
    it('changes password with correct current password', async () => {
      const res = await request(app)
        .put('/api/v1/auth/password')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ current_password: 'password123', new_password: 'newpass123' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Password updated');

      // Verify new password works for login
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'admin', password: 'newpass123' });
      expect(loginRes.status).toBe(200);

      // Reset password for other tests
      const hash = await bcrypt.hash('password123', 12);
      testDb.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(hash);
    });

    it('returns 401 for wrong current password', async () => {
      const res = await request(app)
        .put('/api/v1/auth/password')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ current_password: 'wrong', new_password: 'newpass' });

      expect(res.status).toBe(401);
    });

    it('returns 400 for short new password', async () => {
      const res = await request(app)
        .put('/api/v1/auth/password')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ current_password: 'password123', new_password: '12345' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing fields', async () => {
      const res = await request(app)
        .put('/api/v1/auth/password')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/auth/api-token', () => {
    it('generates a new API token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/api-token')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.api_token).toMatch(/^ud_/);
    });
  });

  describe('DELETE /api/v1/auth/api-token', () => {
    it('revokes the API token', async () => {
      const res = await request(app)
        .delete('/api/v1/auth/api-token')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('API token revoked');
    });
  });
});
