/**
 * Unit tests for auth middleware and token signing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

const mockDbGet = vi.fn();
vi.mock('../../src/db/connection.js', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: mockDbGet })),
  })),
}));

import { authMiddleware, signToken, requireAdmin, type AuthUser } from '../../src/middleware/auth.js';

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers, user: undefined } as unknown as Request;
}
function mockRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

describe('Auth Middleware', () => {
  const secret = 'dev-secret-change-me';
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn();
    delete process.env.JWT_SECRET;
    delete process.env.SESSION_EXPIRY;
  });

  describe('authMiddleware', () => {
    it('returns 401 without Authorization header', () => {
      const req = mockReq(); const res = mockRes();
      authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('authenticates valid JWT with Bearer prefix', () => {
      const token = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, secret);
      const req = mockReq({ authorization: `Bearer ${token}` }); const res = mockRes();
      authMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user).toMatchObject({ id: 1, username: 'admin' });
    });

    it('authenticates valid JWT without Bearer prefix', () => {
      const token = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, secret);
      const req = mockReq({ authorization: token }); const res = mockRes();
      authMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('falls back to API token when JWT invalid', () => {
      mockDbGet.mockReturnValue({ id: 2, username: 'api', role: 'viewer' });
      const req = mockReq({ authorization: 'Bearer bad-jwt' }); const res = mockRes();
      authMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user).toMatchObject({ id: 2, username: 'api' });
    });

    it('returns 401 when both JWT and API token invalid', () => {
      mockDbGet.mockReturnValue(undefined);
      const req = mockReq({ authorization: 'Bearer bad' }); const res = mockRes();
      authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects expired JWT', () => {
      const token = jwt.sign({ id: 1, username: 'a', role: 'admin' }, secret, { expiresIn: '-1s' });
      mockDbGet.mockReturnValue(undefined);
      const req = mockReq({ authorization: `Bearer ${token}` }); const res = mockRes();
      authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('requireAdmin', () => {
    it('calls next for admin users', () => {
      const req = mockReq(); req.user = { id: 1, username: 'admin', role: 'admin' };
      const res = mockRes();
      requireAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 403 for non-admin users', () => {
      const req = mockReq(); req.user = { id: 2, username: 'viewer', role: 'viewer' };
      const res = mockRes();
      requireAdmin(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('signToken', () => {
    it('produces valid JWT with user payload', () => {
      const user: AuthUser = { id: 1, username: 'admin', role: 'admin' };
      const token = signToken(user);
      const decoded = jwt.verify(token, secret) as any;
      expect(decoded.id).toBe(1);
      expect(decoded.username).toBe('admin');
      expect(decoded.exp).toBeDefined();
    });

    it('respects SESSION_EXPIRY env var', () => {
      process.env.SESSION_EXPIRY = '1h';
      const token = signToken({ id: 1, username: 'a', role: 'admin' });
      const decoded = jwt.verify(token, secret) as any;
      expect(decoded.exp - decoded.iat).toBe(3600);
    });

    it('uses custom JWT_SECRET', () => {
      process.env.JWT_SECRET = 'custom-secret';
      const token = signToken({ id: 1, username: 'a', role: 'admin' });
      expect(() => jwt.verify(token, 'custom-secret')).not.toThrow();
      expect(() => jwt.verify(token, secret)).toThrow();
    });
  });
});
