import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/connection.js';

export interface AuthUser {
  id: number;
  username: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_SECRET = () => process.env.JWT_SECRET || 'dev-secret-change-me';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  // Try JWT first
  try {
    const decoded = jwt.verify(token, JWT_SECRET()) as AuthUser;
    req.user = decoded;
    next();
    return;
  } catch {
    // Not a valid JWT — try API token
  }

  // Try API token lookup
  const db = getDb();
  const user = db
    .prepare('SELECT id, username, role FROM users WHERE api_token = ?')
    .get(token) as AuthUser | undefined;

  if (user) {
    req.user = user;
    next();
    return;
  }

  res.status(401).json({ error: 'Invalid or expired token' });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

export function signToken(user: AuthUser): string {
  const expiresIn = (process.env.SESSION_EXPIRY || '7d') as any;
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET(),
    { expiresIn }
  );
}
