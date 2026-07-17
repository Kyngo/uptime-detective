import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { authMiddleware } from '../middleware/auth.js';

export const maintenanceRouter = Router();
maintenanceRouter.use(authMiddleware);

// GET /api/v1/maintenance
maintenanceRouter.get('/maintenance', (req, res) => {
  const db = getDb();
  const windows = db.prepare('SELECT * FROM maintenance_windows ORDER BY start_at DESC').all() as any[];

  // Enrich with linked monitors
  const enriched = windows.map((w) => {
    const monitors = db.prepare(`
      SELECT m.id, m.name FROM monitors m
      JOIN maintenance_monitors mm ON mm.monitor_id = m.id
      WHERE mm.maintenance_id = ?
    `).all(w.id);
    return { ...w, monitors };
  });

  res.json(enriched);
});

// GET /api/v1/maintenance/:id
maintenanceRouter.get('/maintenance/:id', (req, res) => {
  const db = getDb();
  const window = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(Number(req.params.id)) as any;
  if (!window) { res.status(404).json({ error: 'Maintenance window not found' }); return; }

  const monitors = db.prepare(`
    SELECT m.id, m.name FROM monitors m
    JOIN maintenance_monitors mm ON mm.monitor_id = m.id
    WHERE mm.maintenance_id = ?
  `).all(window.id);

  res.json({ ...window, monitors });
});

// POST /api/v1/maintenance
maintenanceRouter.post('/maintenance', (req, res) => {
  const db = getDb();
  const { title, description, start_at, end_at, recurring, monitor_ids } = req.body;

  if (!title || !start_at || !end_at) {
    res.status(400).json({ error: 'title, start_at, and end_at are required' }); return;
  }

  const result = db.prepare(`
    INSERT INTO maintenance_windows (title, description, start_at, end_at, recurring)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, description || null, start_at, end_at, recurring || null);

  const windowId = result.lastInsertRowid;

  // Link monitors
  if (Array.isArray(monitor_ids) && monitor_ids.length > 0) {
    const insert = db.prepare('INSERT INTO maintenance_monitors (maintenance_id, monitor_id) VALUES (?, ?)');
    const batch = db.transaction((ids: number[]) => {
      for (const mid of ids) insert.run(windowId, mid);
    });
    batch(monitor_ids);
  }

  const window = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(windowId) as any;
  const monitors = db.prepare(`
    SELECT m.id, m.name FROM monitors m JOIN maintenance_monitors mm ON mm.monitor_id = m.id WHERE mm.maintenance_id = ?
  `).all(windowId as number);

  res.status(201).json({ ...window, monitors });
});

// PUT /api/v1/maintenance/:id
maintenanceRouter.put('/maintenance/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM maintenance_windows WHERE id = ?').get(id);
  if (!existing) { res.status(404).json({ error: 'Maintenance window not found' }); return; }

  const { title, description, start_at, end_at, recurring, monitor_ids } = req.body;

  db.prepare(`
    UPDATE maintenance_windows SET
      title = COALESCE(?, title), description = COALESCE(?, description),
      start_at = COALESCE(?, start_at), end_at = COALESCE(?, end_at),
      recurring = COALESCE(?, recurring)
    WHERE id = ?
  `).run(title || null, description !== undefined ? description : null, start_at || null, end_at || null, recurring !== undefined ? recurring : null, id);

  // Re-link monitors if provided
  if (Array.isArray(monitor_ids)) {
    db.prepare('DELETE FROM maintenance_monitors WHERE maintenance_id = ?').run(id);
    const insert = db.prepare('INSERT INTO maintenance_monitors (maintenance_id, monitor_id) VALUES (?, ?)');
    const batch = db.transaction((ids: number[]) => {
      for (const mid of ids) insert.run(id, mid);
    });
    batch(monitor_ids);
  }

  const window = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id) as any;
  const monitors = db.prepare(`
    Select m.id, m.name FROM monitors m JOIN maintenance_monitors mm ON mm.monitor_id = m.id WHERE mm.maintenance_id = ?
  `).all(id);

  res.json({ ...window, monitors });
});

// DELETE /api/v1/maintenance/:id
maintenanceRouter.delete('/maintenance/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM maintenance_windows WHERE id = ?').get(id);
  if (!existing) { res.status(404).json({ error: 'Maintenance window not found' }); return; }

  db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(id);
  res.json({ message: 'Maintenance window deleted' });
});
