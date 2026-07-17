import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { getDb } from '../db/connection.js';
import { authMiddleware, signToken } from '../middleware/auth.js';

export const authRouter = Router();

// Rate limit login attempts: 5 per minute per IP in production, relaxed in dev
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'production' ? 5 : 100,
  message: { error: 'Too many login attempts. Please try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/v1/auth/login
authRouter.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const db = getDb();
  const user = db
    .prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?')
    .get(username) as { id: number; username: string; password_hash: string; role: string } | undefined;

  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = signToken({ id: user.id, username: user.username, role: user.role });

  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
});

// GET /api/v1/auth/me — get current user info
authRouter.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db
    .prepare('SELECT id, username, role, api_token, created_at FROM users WHERE id = ?')
    .get(req.user!.id) as any;

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json(user);
});

// POST /api/v1/auth/api-token — generate new API token
authRouter.post('/api-token', authMiddleware, (req, res) => {
  const db = getDb();
  const token = `ud_${crypto.randomBytes(24).toString('hex')}`;

  db.prepare('UPDATE users SET api_token = ? WHERE id = ?').run(token, req.user!.id);

  res.json({ api_token: token });
});

// DELETE /api/v1/auth/api-token — revoke API token
authRouter.delete('/api-token', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE users SET api_token = NULL WHERE id = ?').run(req.user!.id);

  res.json({ message: 'API token revoked' });
});

// PUT /api/v1/auth/password — change password
authRouter.put('/password', authMiddleware, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    res.status(400).json({ error: 'Current and new password are required' });
    return;
  }

  if (new_password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }

  const db = getDb();
  const user = db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(req.user!.id) as { password_hash: string } | undefined;

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  const hash = await bcrypt.hash(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user!.id);

  res.json({ message: 'Password updated' });
});
