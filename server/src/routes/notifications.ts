import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { authMiddleware } from '../middleware/auth.js';
import { sendTestNotification } from '../services/notifiers/dispatcher.js';

export const notificationsRouter = Router();
notificationsRouter.use(authMiddleware);

// GET /api/v1/notifications
notificationsRouter.get('/notifications', (req, res) => {
  const db = getDb();
  const channels = db.prepare('SELECT * FROM notifications ORDER BY name ASC').all() as any[];
  res.json(channels.map((c) => ({ ...c, config: typeof c.config === 'string' ? JSON.parse(c.config) : c.config })));
});

// GET /api/v1/notifications/:id
notificationsRouter.get('/notifications/:id', (req, res) => {
  const db = getDb();
  const channel = db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(req.params.id)) as any;
  if (!channel) { res.status(404).json({ error: 'Channel not found' }); return; }
  res.json({ ...channel, config: typeof channel.config === 'string' ? JSON.parse(channel.config) : channel.config });
});

// POST /api/v1/notifications
notificationsRouter.post('/notifications', (req, res) => {
  const db = getDb();
  const { name, type, config, is_default } = req.body;

  if (!name || !type || !config) { res.status(400).json({ error: 'name, type, and config are required' }); return; }
  const validTypes = ['webhook', 'email', 'slack', 'discord', 'telegram'];
  if (!validTypes.includes(type)) { res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` }); return; }

  const result = db.prepare(
    'INSERT INTO notifications (name, type, config, is_default) VALUES (?, ?, ?, ?)'
  ).run(name, type, JSON.stringify(config), is_default ? 1 : 0);

  const channel = db.prepare('SELECT * FROM notifications WHERE id = ?').get(result.lastInsertRowid) as any;
  res.status(201).json({ ...channel, config: JSON.parse(channel.config) });
});

// PUT /api/v1/notifications/:id
notificationsRouter.put('/notifications/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM notifications WHERE id = ?').get(id);
  if (!existing) { res.status(404).json({ error: 'Channel not found' }); return; }

  const { name, type, config, is_default } = req.body;
  db.prepare(`
    UPDATE notifications SET name = COALESCE(?, name), type = COALESCE(?, type),
    config = COALESCE(?, config), is_default = COALESCE(?, is_default) WHERE id = ?
  `).run(name || null, type || null, config ? JSON.stringify(config) : null, is_default !== undefined ? (is_default ? 1 : 0) : null, id);

  const channel = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as any;
  res.json({ ...channel, config: typeof channel.config === 'string' ? JSON.parse(channel.config) : channel.config });
});

// DELETE /api/v1/notifications/:id
notificationsRouter.delete('/notifications/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM notifications WHERE id = ?').get(id);
  if (!existing) { res.status(404).json({ error: 'Channel not found' }); return; }
  db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
  res.json({ message: 'Channel deleted' });
});

// POST /api/v1/notifications/:id/test
notificationsRouter.post('/notifications/:id/test', async (req, res) => {
  try {
    await sendTestNotification(Number(req.params.id));
    res.json({ message: 'Test notification sent' });
  } catch (err: any) {
    res.status(500).json({ error: `Test failed: ${err.message}` });
  }
});

// POST /api/v1/monitors/:monitorId/notifications/:notificationId — link
notificationsRouter.post('/monitors/:monitorId/notifications/:notificationId', (req, res) => {
  const db = getDb();
  const monitorId = Number(req.params.monitorId);
  const notificationId = Number(req.params.notificationId);

  const monitor = db.prepare('SELECT id FROM monitors WHERE id = ?').get(monitorId);
  if (!monitor) { res.status(404).json({ error: 'Monitor not found' }); return; }
  const channel = db.prepare('SELECT id FROM notifications WHERE id = ?').get(notificationId);
  if (!channel) { res.status(404).json({ error: 'Channel not found' }); return; }

  db.prepare('INSERT OR IGNORE INTO monitor_notifications (monitor_id, notification_id) VALUES (?, ?)').run(monitorId, notificationId);
  res.json({ message: 'Linked' });
});

// DELETE /api/v1/monitors/:monitorId/notifications/:notificationId — unlink
notificationsRouter.delete('/monitors/:monitorId/notifications/:notificationId', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM monitor_notifications WHERE monitor_id = ? AND notification_id = ?')
    .run(Number(req.params.monitorId), Number(req.params.notificationId));
  res.json({ message: 'Unlinked' });
});

// GET /api/v1/monitors/:monitorId/notifications — list linked channels
notificationsRouter.get('/monitors/:monitorId/notifications', (req, res) => {
  const db = getDb();
  const channels = db.prepare(`
    SELECT n.* FROM notifications n
    JOIN monitor_notifications mn ON mn.notification_id = n.id
    WHERE mn.monitor_id = ?
  `).all(Number(req.params.monitorId)) as any[];
  res.json(channels.map((c) => ({ ...c, config: typeof c.config === 'string' ? JSON.parse(c.config) : c.config })));
});
