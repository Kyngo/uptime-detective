import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { authMiddleware } from '../middleware/auth.js';

export const groupsRouter = Router();
groupsRouter.use(authMiddleware);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// GET /api/v1/groups
groupsRouter.get('/groups', (req, res) => {
  const db = getDb();
  const groups = db.prepare('SELECT * FROM groups ORDER BY sort_order ASC, name ASC').all();

  // Attach monitor count per group
  const enriched = (groups as any[]).map((g) => {
    const { count } = db.prepare('SELECT COUNT(*) as count FROM monitors WHERE group_id = ?').get(g.id) as { count: number };
    return { ...g, monitor_count: count };
  });

  res.json(enriched);
});

// GET /api/v1/groups/:id
groupsRouter.get('/groups/:id', (req, res) => {
  const db = getDb();
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(Number(req.params.id));
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  // Include monitors in this group
  const monitors = db.prepare('SELECT * FROM monitors WHERE group_id = ? ORDER BY name ASC').all(Number(req.params.id));
  res.json({ ...group, monitors });
});

// POST /api/v1/groups
groupsRouter.post('/groups', (req, res) => {
  const db = getDb();
  const { name, description, sort_order } = req.body;

  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  let slug = slugify(name);
  // Ensure unique slug
  const existing = db.prepare('SELECT id FROM groups WHERE slug = ?').get(slug);
  if (existing) slug = `${slug}-${Date.now().toString(36)}`;

  const result = db.prepare(
    'INSERT INTO groups (name, slug, description, sort_order) VALUES (?, ?, ?, ?)'
  ).run(name, slug, description || null, sort_order || 0);

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(group);
});

// PUT /api/v1/groups/:id
groupsRouter.put('/groups/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!existing) { res.status(404).json({ error: 'Group not found' }); return; }

  const { name, description, sort_order } = req.body;

  // Regenerate slug if name changed
  let slug = (existing as any).slug;
  if (name && name !== (existing as any).name) {
    slug = slugify(name);
    const dup = db.prepare('SELECT id FROM groups WHERE slug = ? AND id != ?').get(slug, id);
    if (dup) slug = `${slug}-${Date.now().toString(36)}`;
  }

  db.prepare(
    'UPDATE groups SET name = COALESCE(?, name), slug = ?, description = COALESCE(?, description), sort_order = COALESCE(?, sort_order) WHERE id = ?'
  ).run(name || null, slug, description !== undefined ? description : null, sort_order ?? null, id);

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  res.json(group);
});

// DELETE /api/v1/groups/:id
groupsRouter.delete('/groups/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM groups WHERE id = ?').get(id);
  if (!existing) { res.status(404).json({ error: 'Group not found' }); return; }

  // Monitors in this group will have group_id set to NULL (ON DELETE SET NULL)
  db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  res.json({ message: 'Group deleted' });
});

// GET /api/v1/groups/:id/monitors — list monitors in this group
groupsRouter.get('/groups/:id/monitors', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM groups WHERE id = ?').get(id);
  if (!existing) { res.status(404).json({ error: 'Group not found' }); return; }

  const monitors = db.prepare('SELECT id, name, type, target FROM monitors WHERE group_id = ? ORDER BY name ASC').all(id);
  res.json(monitors);
});

// GET /api/v1/groups/available-monitors — monitors not assigned to any group (or search all)
groupsRouter.get('/available-monitors', (req, res) => {
  const db = getDb();
  const search = (req.query.search as string || '').trim();
  const excludeGroup = req.query.exclude_group ? Number(req.query.exclude_group) : null;

  let query = 'SELECT id, name, type, target, group_id FROM monitors WHERE 1=1';
  const params: any[] = [];

  if (search) {
    query += ' AND name LIKE ?';
    params.push(`%${search}%`);
  }

  if (excludeGroup) {
    query += ' AND (group_id IS NULL OR group_id != ?)';
    params.push(excludeGroup);
  } else {
    query += ' AND group_id IS NULL';
  }

  query += ' ORDER BY name ASC LIMIT 20';

  const monitors = db.prepare(query).all(...params);
  res.json(monitors);
});

// POST /api/v1/groups/:id/monitors — add a monitor to this group
groupsRouter.post('/groups/:id/monitors', (req, res) => {
  const db = getDb();
  const groupId = Number(req.params.id);
  const { monitor_id } = req.body;

  if (!monitor_id) { res.status(400).json({ error: 'monitor_id is required' }); return; }

  const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const monitor = db.prepare('SELECT id FROM monitors WHERE id = ?').get(Number(monitor_id));
  if (!monitor) { res.status(404).json({ error: 'Monitor not found' }); return; }

  db.prepare('UPDATE monitors SET group_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(groupId, Number(monitor_id));
  res.json({ message: 'Monitor added to group' });
});

// DELETE /api/v1/groups/:id/monitors/:monitorId — remove a monitor from this group
groupsRouter.delete('/groups/:id/monitors/:monitorId', (req, res) => {
  const db = getDb();
  const groupId = Number(req.params.id);
  const monitorId = Number(req.params.monitorId);

  const monitor = db.prepare('SELECT id, group_id FROM monitors WHERE id = ?').get(monitorId) as any;
  if (!monitor) { res.status(404).json({ error: 'Monitor not found' }); return; }
  if (monitor.group_id !== groupId) { res.status(400).json({ error: 'Monitor is not in this group' }); return; }

  db.prepare('UPDATE monitors SET group_id = NULL, updated_at = datetime(\'now\') WHERE id = ?').run(monitorId);
  res.json({ message: 'Monitor removed from group' });
});
