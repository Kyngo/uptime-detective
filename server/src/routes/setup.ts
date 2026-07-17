import { Router } from 'express';
import bcrypt from 'bcrypt';
import { getDb } from '../db/connection.js';
import { signToken } from '../middleware/auth.js';

export const setupRouter = Router();

/**
 * Check if the initial setup has been completed.
 * Setup is NOT needed if:
 * - The 'setup_completed' setting is 'true', OR
 * - Users already exist (covers pre-wizard installations that were seeded)
 */
function isSetupNeeded(): boolean {
  const db = getDb();

  const setting = db
    .prepare("SELECT value FROM settings WHERE key = 'setup_completed'")
    .get() as { value: string } | undefined;

  if (setting?.value === 'true') {
    return false;
  }

  // If users already exist (e.g., from db:seed), setup isn't needed
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  if (userCount.count > 0) {
    // Auto-mark setup as complete for existing installations
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('setup_completed', 'true', CURRENT_TIMESTAMP)"
    ).run();
    return false;
  }

  return true;
}

// GET /api/v1/setup/status — check if setup is needed (public, no auth)
setupRouter.get('/status', (_req, res) => {
  res.json({ needsSetup: isSetupNeeded() });
});

// POST /api/v1/setup/complete — perform initial setup (public, only works once)
setupRouter.post('/complete', async (req, res) => {
  if (!isSetupNeeded()) {
    res.status(403).json({ error: 'Setup has already been completed' });
    return;
  }

  const { username, password, notifications } = req.body;

  // Validate required fields
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  if (username.length < 3) {
    res.status(400).json({ error: 'Username must be at least 3 characters' });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }

  const db = getDb();

  try {
    // 1. Delete any existing seed users and create the admin user
    db.prepare('DELETE FROM users').run();

    const passwordHash = await bcrypt.hash(password, 12);
    const userResult = db.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).run(username, passwordHash, 'admin');

    // 2. Create notification channels if provided
    if (notifications && Array.isArray(notifications)) {
      for (const notif of notifications) {
        if (!notif.name || !notif.type || !notif.config) continue;

        const validTypes = ['webhook', 'email', 'slack', 'discord', 'telegram'];
        if (!validTypes.includes(notif.type)) continue;

        db.prepare(
          'INSERT INTO notifications (name, type, config, is_default) VALUES (?, ?, ?, ?)'
        ).run(notif.name, notif.type, JSON.stringify(notif.config), notif.is_default ? 1 : 0);
      }
    }

    // 3. Mark setup as complete
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('setup_completed', 'true', CURRENT_TIMESTAMP)"
    ).run();

    // 4. Generate JWT token for immediate login
    const userId = userResult.lastInsertRowid as number;
    const token = signToken({ id: userId, username, role: 'admin' });

    res.json({
      message: 'Setup completed successfully',
      token,
      user: { id: userId, username, role: 'admin' },
    });
  } catch (err: any) {
    console.error('[setup] Error completing setup:', err);
    res.status(500).json({ error: 'Setup failed: ' + err.message });
  }
});
