import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { recordHeartbeat } from '../services/checker/heartbeat.js';
import type { Monitor } from '@uptime-detective/shared';

export const heartbeatRouter = Router();

/**
 * GET /api/v1/heartbeat/:token
 * 
 * Public endpoint (no auth required). External services hit this URL
 * to report they are alive. The token is unique per heartbeat monitor.
 * 
 * Also supports POST for flexibility.
 */
heartbeatRouter.all('/heartbeat/:token', (req, res) => {
  const { token } = req.params;

  const db = getDb();
  const row = db
    .prepare('SELECT * FROM monitors WHERE heartbeat_token = ? AND type = ?')
    .get(token, 'heartbeat') as any;

  if (!row) {
    res.status(404).json({ error: 'Invalid heartbeat token' });
    return;
  }

  const monitor: Monitor = {
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {}),
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags || []),
    active: Boolean(row.active),
  };

  // Record the heartbeat
  recordHeartbeat(monitor);

  res.json({ ok: true, msg: 'Heartbeat received' });
});
