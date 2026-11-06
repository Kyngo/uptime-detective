import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  createMonitor,
  deleteMonitor,
  getMonitorWithStatus,
  listMonitorsWithStatus,
  setMonitorActive,
  updateMonitor,
  validateCreateMonitorInput,
} from '../services/monitor-service.js';

export const monitorsRouter = Router();

// All monitor routes require authentication
monitorsRouter.use('/monitors', authMiddleware);

// GET /api/v1/monitors
monitorsRouter.get('/monitors', (req, res) => {
  const { group_id, tag, active } = req.query;

  const monitors = listMonitorsWithStatus({
    group_id: group_id ? Number(group_id) : undefined,
    tag: typeof tag === 'string' ? tag : undefined,
    active: active !== undefined ? active === 'true' : undefined,
  });

  res.json(monitors);
});

// GET /api/v1/monitors/:id
monitorsRouter.get('/monitors/:id', (req, res) => {
  const monitor = getMonitorWithStatus(Number(req.params.id));
  if (!monitor) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  res.json(monitor);
});

// POST /api/v1/monitors
monitorsRouter.post('/monitors', (req, res) => {
  const validationError = validateCreateMonitorInput(req.body || {});
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const monitor = createMonitor(req.body);
  res.status(201).json(monitor);
});

// PUT /api/v1/monitors/:id
monitorsRouter.put('/monitors/:id', (req, res) => {
  const monitor = updateMonitor(Number(req.params.id), req.body || {});
  if (!monitor) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  res.json(monitor);
});

// DELETE /api/v1/monitors/:id
monitorsRouter.delete('/monitors/:id', (req, res) => {
  const deleted = deleteMonitor(Number(req.params.id));
  if (!deleted) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  res.json({ message: 'Monitor deleted' });
});

// POST /api/v1/monitors/:id/pause
monitorsRouter.post('/monitors/:id/pause', (req, res) => {
  const monitor = setMonitorActive(Number(req.params.id), false);
  if (!monitor) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  res.json(monitor);
});

// POST /api/v1/monitors/:id/resume
monitorsRouter.post('/monitors/:id/resume', (req, res) => {
  const monitor = setMonitorActive(Number(req.params.id), true);
  if (!monitor) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
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
