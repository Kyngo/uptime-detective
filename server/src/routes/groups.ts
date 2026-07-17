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
