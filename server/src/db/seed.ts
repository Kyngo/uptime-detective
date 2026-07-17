import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { getDb } from './connection.js';
import { migrate } from './migrate.js';

async function seed(): Promise<void> {
  // Ensure schema exists
  migrate();

  const db = getDb();

  // Check if admin user already exists
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (existing) {
    console.log('[seed] Admin user already exists, skipping');
    return;
  }

  // Generate a random initial password (16 chars, alphanumeric)
  const initialPassword = crypto.randomBytes(12).toString('base64url').slice(0, 16);
  const passwordHash = await bcrypt.hash(initialPassword, 12);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
    'admin',
    passwordHash,
    'admin'
  );

  console.log('[seed] Created default admin user');
  console.log('[seed] ══════════════════════════════════════════════════');
  console.log(`[seed]   Username: admin`);
  console.log(`[seed]   Password: ${initialPassword}`);
  console.log('[seed] ══════════════════════════════════════════════════');
  console.log('[seed] ⚠️  Save this password now — it will not be shown again!');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] Error:', err);
    process.exit(1);
  });
