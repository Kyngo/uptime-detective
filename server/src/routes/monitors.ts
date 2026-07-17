import { Router } from 'express';
import crypto from 'crypto';
import { getDb } from '../db/connection.js';
import { authMiddleware } from '../middleware/auth.js';
import { startMonitorJob, stopMonitorJob, updateMonitorJob } from '../services/scheduler.js';
import { getIO } from '../socket.js';
import type { Monitor, MonitorWithStatus, MonitorStatus } from '@uptime-detective/shared';

export const monitorsRouter = Router();

// All monitor routes require authentication
monitorsRouter.use('/monitors', authMiddleware);

// === Helper functions ===

function parseMonitorRow(row: any): Monitor {
  return {
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {}),
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags || []),
    active: Boolean(row.active),
  };
}

function getMonitorStatus(monitorId: number): { status: MonitorStatus; lastCheck: any; uptime24h: number | null; avgResponseTime: number | null } {
  const db = getDb();

  const lastCheck = db
    .prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(monitorId) as any;

  let status: MonitorStatus = 'pending';
  if (lastCheck) {
    const statusMap: Record<number, MonitorStatus> = { 0: 'down', 1: 'up', 2: 'degraded', 3: 'maintenance' };
    status = statusMap[lastCheck.status] || 'down';
  }

  // Calculate 24h uptime
  const uptimeRow = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as successful
    FROM checks 
    WHERE monitor_id = ? AND created_at >= datetime('now', '-1 day')
  `).get(monitorId) as { total: number; successful: number };

  const uptime24h = uptimeRow.total > 0 ? (uptimeRow.successful / uptimeRow.total) * 100 : null;

  // Average response time (last 24h)
  const avgRow = db.prepare(`
    SELECT AVG(response_time) as avg_rt
    FROM checks 
    WHERE monitor_id = ? AND created_at >= datetime('now', '-1 day') AND response_time IS NOT NULL
  `).get(monitorId) as { avg_rt: number | null };

  return {
    status,
    lastCheck,
    uptime24h: uptime24h !== null ? Math.round(uptime24h * 100) / 100 : null,
    avgResponseTime: avgRow.avg_rt !== null ? Math.round(avgRow.avg_rt) : null,
  };
}

// === Routes ===

// GET /api/v1/monitors
monitorsRouter.get('/monitors', (req, res) => {
  const db = getDb();
  const { group_id, tag, active } = req.query;

  let query = 'SELECT * FROM monitors WHERE 1=1';
  const params: any[] = [];

  if (group_id) {
    query += ' AND group_id = ?';
    params.push(Number(group_id));
  }

  if (active !== undefined) {
    query += ' AND active = ?';
    params.push(active === 'true' ? 1 : 0);
  }

  query += ' ORDER BY name ASC';

  const rows = db.prepare(query).all(...params) as any[];
  const monitors: MonitorWithStatus[] = rows.map((row) => {
    const monitor = parseMonitorRow(row);
    const { status, lastCheck, uptime24h, avgResponseTime } = getMonitorStatus(monitor.id);

    return {
      ...monitor,
      current_status: status,
      last_check: lastCheck || null,
      uptime_24h: uptime24h,
      avg_response_time: avgResponseTime,
    };
  });

  // Filter by tag if provided (post-query since tags is JSON)
  if (tag) {
    const filtered = monitors.filter((m) => m.tags.includes(tag as string));
    res.json(filtered);
    return;
  }

  res.json(monitors);
});

// GET /api/v1/monitors/:id
monitorsRouter.get('/monitors/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM monitors WHERE id = ?').get(Number(req.params.id)) as any;

  if (!row) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }

  const monitor = parseMonitorRow(row);
  const { status, lastCheck, uptime24h, avgResponseTime } = getMonitorStatus(monitor.id);

  res.json({
    ...monitor,
    current_status: status,
    last_check: lastCheck || null,
    uptime_24h: uptime24h,
    avg_response_time: avgResponseTime,
  });
});

// POST /api/v1/monitors
monitorsRouter.post('/monitors', (req, res) => {
  const db = getDb();
  const { name, type, target, interval, timeout, retries, retry_interval, config, group_id, tags, active } = req.body;

  if (!name || !type || !target) {
    res.status(400).json({ error: 'name, type, and target are required' });
    return;
  }

  const validTypes = ['http', 'icmp', 'dns', 'tls', 'tcp', 'heartbeat'];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
    return;
  }

  // Generate heartbeat token for heartbeat monitors
  const heartbeatToken = type === 'heartbeat' ? crypto.randomBytes(16).toString('hex') : null;

  const result = db.prepare(`
    INSERT INTO monitors (name, type, target, interval, timeout, retries, retry_interval, config, group_id, tags, active, heartbeat_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    type,
    target,
    interval || 60,
    timeout || 10000,
    retries || 1,
    retry_interval || 30,
    JSON.stringify(config || {}),
    group_id || null,
    JSON.stringify(tags || []),
    active !== false ? 1 : 0,
    heartbeatToken,
  );

  const monitor = parseMonitorRow(
    db.prepare('SELECT * FROM monitors WHERE id = ?').get(result.lastInsertRowid) as any
  );

  // Start the scheduler job
  if (monitor.active) {
    startMonitorJob(monitor);
  }

  // Notify connected clients
  try {
    getIO().emit('monitor:created', monitor);
  } catch {}

  res.status(201).json(monitor);
});

// PUT /api/v1/monitors/:id
monitorsRouter.put('/monitors/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);

  const existing = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any;
  if (!existing) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }

  const { name, type, target, interval, timeout, retries, retry_interval, config, group_id, tags, active } = req.body;

  db.prepare(`
    UPDATE monitors SET 
      name = COALESCE(?, name),
      type = COALESCE(?, type),
      target = COALESCE(?, target),
      interval = COALESCE(?, interval),
      timeout = COALESCE(?, timeout),
      retries = COALESCE(?, retries),
      retry_interval = COALESCE(?, retry_interval),
      config = COALESCE(?, config),
      group_id = ?,
      tags = COALESCE(?, tags),
      active = COALESCE(?, active),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? null,
    type ?? null,
    target ?? null,
    interval !== undefined ? interval : null,
    timeout !== undefined ? timeout : null,
    retries !== undefined ? retries : null,
    retry_interval !== undefined ? retry_interval : null,
    config ? JSON.stringify(config) : null,
    group_id !== undefined ? group_id : existing.group_id,
    tags ? JSON.stringify(tags) : null,
    active !== undefined ? (active ? 1 : 0) : null,
    id,
  );

  const monitor = parseMonitorRow(
    db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any
  );

  // Update scheduler
  updateMonitorJob(monitor);

  // Notify connected clients
  try {
    getIO().emit('monitor:updated', monitor);
  } catch {}

  res.json(monitor);
});

// DELETE /api/v1/monitors/:id
monitorsRouter.delete('/monitors/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);

  const existing = db.prepare('SELECT id FROM monitors WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }

  // Stop scheduler job
  stopMonitorJob(id);

  // Delete (cascades to checks, incidents, etc.)
  db.prepare('DELETE FROM monitors WHERE id = ?').run(id);

  // Notify connected clients
  try {
    getIO().emit('monitor:deleted', { monitor_id: id });
  } catch {}

  res.json({ message: 'Monitor deleted' });
});

// POST /api/v1/monitors/:id/pause
monitorsRouter.post('/monitors/:id/pause', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);

  const existing = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any;
  if (!existing) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }

  db.prepare('UPDATE monitors SET active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id);
  stopMonitorJob(id);

  const monitor = parseMonitorRow(db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any);
  try { getIO().emit('monitor:updated', monitor); } catch {}

  res.json(monitor);
});

// POST /api/v1/monitors/:id/resume
monitorsRouter.post('/monitors/:id/resume', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);

  const existing = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any;
  if (!existing) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }

  db.prepare('UPDATE monitors SET active = 1, updated_at = datetime(\'now\') WHERE id = ?').run(id);

  const monitor = parseMonitorRow(db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as any);
  startMonitorJob(monitor);
  try { getIO().emit('monitor:updated', monitor); } catch {}

  res.json(monitor);
});

// GET /api/v1/monitors/:id/checks — check history
monitorsRouter.get('/monitors/:id/checks', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const { from, to, limit, offset } = req.query;

  // Verify monitor exists
  const exists = db.prepare('SELECT id FROM monitors WHERE id = ?').get(id);
  if (!exists) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }

  let query = 'SELECT * FROM checks WHERE monitor_id = ?';
  const params: any[] = [id];

  if (from) {
    query += ' AND created_at >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND created_at <= ?';
    params.push(to);
  }

  query += ' ORDER BY created_at DESC';

  const lim = Math.min(Number(limit) || 100, 1000);
  const off = Number(offset) || 0;
  query += ` LIMIT ? OFFSET ?`;
  params.push(lim, off);

  const checks = db.prepare(query).all(...params);

  // Get total count for pagination
  let countQuery = 'SELECT COUNT(*) as total FROM checks WHERE monitor_id = ?';
  const countParams: any[] = [id];
  if (from) { countQuery += ' AND created_at >= ?'; countParams.push(from); }
  if (to) { countQuery += ' AND created_at <= ?'; countParams.push(to); }
  const { total } = db.prepare(countQuery).get(...countParams) as { total: number };

  res.json({ checks, total, limit: lim, offset: off });
});

// GET /api/v1/monitors/:id/uptime — uptime calculation
monitorsRouter.get('/monitors/:id/uptime', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const days = Number(req.query.days) || 30;

  const exists = db.prepare('SELECT id FROM monitors WHERE id = ?').get(id);
  if (!exists) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }

  const row = db.prepare(`
    SELECT 
      COUNT(*) as total_checks,
      SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as successful_checks
    FROM checks 
    WHERE monitor_id = ? AND created_at >= datetime('now', ? || ' days')
  `).get(id, -days) as { total_checks: number; successful_checks: number };

  const uptime = row.total_checks > 0
    ? Math.round((row.successful_checks / row.total_checks) * 10000) / 100
    : 100;

  res.json({
    monitor_id: id,
    period_days: days,
    uptime_percentage: uptime,
    total_checks: row.total_checks,
    successful_checks: row.successful_checks,
  });
});
