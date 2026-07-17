import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { authMiddleware } from '../middleware/auth.js';

export const statusPagesRouter = Router();
statusPagesRouter.use(authMiddleware);

/**
 * Sanitise user-provided CSS to prevent XSS and data exfiltration.
 * Strips dangerous patterns: url(), expression(), @import, javascript:, behavior, -moz-binding.
 */
function sanitizeCss(css: string | null | undefined): string | null {
  if (!css) return null;
  let sanitized = css;
  // Remove url() calls (can exfiltrate data or load external resources)
  sanitized = sanitized.replace(/url\s*\([^)]*\)/gi, '/* blocked:url */');
  // Remove @import rules
  sanitized = sanitized.replace(/@import\s+[^;]+;?/gi, '/* blocked:import */');
  // Remove expression() (IE CSS expressions)
  sanitized = sanitized.replace(/expression\s*\([^)]*\)/gi, '/* blocked:expression */');
  // Remove javascript: pseudo-protocol
  sanitized = sanitized.replace(/javascript\s*:/gi, '/* blocked */');
  // Remove behavior/binding (IE/Firefox extension vectors)
  sanitized = sanitized.replace(/behavior\s*:/gi, '/* blocked */');
  sanitized = sanitized.replace(/-moz-binding\s*:/gi, '/* blocked */');
  // Remove HTML tags that might break out of <style>
  sanitized = sanitized.replace(/<[^>]*>/g, '');
  return sanitized;
}

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// GET /api/v1/status-pages
statusPagesRouter.get('/status-pages', (req, res) => {
  const db = getDb();
  const pages = db.prepare('SELECT * FROM status_pages ORDER BY title ASC').all();
  res.json(pages);
});

// GET /api/v1/status-pages/:id
statusPagesRouter.get('/status-pages/:id', (req, res) => {
  const db = getDb();
  const page = db.prepare('SELECT * FROM status_pages WHERE id = ?').get(Number(req.params.id));
  if (!page) { res.status(404).json({ error: 'Status page not found' }); return; }

  const items = db.prepare('SELECT * FROM status_page_items WHERE status_page_id = ? ORDER BY sort_order ASC').all(Number(req.params.id));
  res.json({ ...page, items });
});

// POST /api/v1/status-pages
statusPagesRouter.post('/status-pages', (req, res) => {
  const db = getDb();
  const { title, description, logo_url, custom_css, is_public, show_powered_by } = req.body;

  if (!title) { res.status(400).json({ error: 'title is required' }); return; }

  let slug = slugify(title);
  const existing = db.prepare('SELECT id FROM status_pages WHERE slug = ?').get(slug);
  if (existing) slug = `${slug}-${Date.now().toString(36)}`;

  const result = db.prepare(`
    INSERT INTO status_pages (title, slug, description, logo_url, custom_css, is_public, show_powered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(title, slug, description || null, logo_url || null, sanitizeCss(custom_css), is_public !== false ? 1 : 0, show_powered_by !== false ? 1 : 0);

  const page = db.prepare('SELECT * FROM status_pages WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(page);
});

// PUT /api/v1/status-pages/:id
statusPagesRouter.put('/status-pages/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM status_pages WHERE id = ?').get(id) as any;
  if (!existing) { res.status(404).json({ error: 'Status page not found' }); return; }

  const { title, description, logo_url, custom_css, is_public, show_powered_by } = req.body;

  let slug = existing.slug;
  if (title && title !== existing.title) {
    slug = slugify(title);
    const dup = db.prepare('SELECT id FROM status_pages WHERE slug = ? AND id != ?').get(slug, id);
    if (dup) slug = `${slug}-${Date.now().toString(36)}`;
  }

  db.prepare(`
    UPDATE status_pages SET
      title = COALESCE(?, title), slug = ?, description = COALESCE(?, description),
      logo_url = COALESCE(?, logo_url), custom_css = COALESCE(?, custom_css),
      is_public = COALESCE(?, is_public), show_powered_by = COALESCE(?, show_powered_by)
    WHERE id = ?
  `).run(
    title || null, slug, description !== undefined ? description : null,
    logo_url !== undefined ? logo_url : null, custom_css !== undefined ? sanitizeCss(custom_css) : null,
    is_public !== undefined ? (is_public ? 1 : 0) : null,
    show_powered_by !== undefined ? (show_powered_by ? 1 : 0) : null,
    id
  );

  const page = db.prepare('SELECT * FROM status_pages WHERE id = ?').get(id);
  res.json(page);
});

// DELETE /api/v1/status-pages/:id
statusPagesRouter.delete('/status-pages/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM status_pages WHERE id = ?').get(id);
  if (!existing) { res.status(404).json({ error: 'Status page not found' }); return; }

  db.prepare('DELETE FROM status_pages WHERE id = ?').run(id);
  res.json({ message: 'Status page deleted' });
});

// POST /api/v1/status-pages/:id/items — add a group or monitor to the page
statusPagesRouter.post('/status-pages/:id/items', (req, res) => {
  const db = getDb();
  const pageId = Number(req.params.id);
  const { group_id, monitor_id, sort_order } = req.body;

  const page = db.prepare('SELECT id FROM status_pages WHERE id = ?').get(pageId);
  if (!page) { res.status(404).json({ error: 'Status page not found' }); return; }

  if (!group_id && !monitor_id) { res.status(400).json({ error: 'Either group_id or monitor_id is required' }); return; }
  if (group_id && monitor_id) { res.status(400).json({ error: 'Provide group_id or monitor_id, not both' }); return; }

  // Determine next sort_order if not provided
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM status_page_items WHERE status_page_id = ?').get(pageId) as { max: number | null };
  const order = sort_order ?? ((maxOrder.max ?? -1) + 1);

  const result = db.prepare(
    'INSERT INTO status_page_items (status_page_id, group_id, monitor_id, sort_order) VALUES (?, ?, ?, ?)'
  ).run(pageId, group_id || null, monitor_id || null, order);

  const item = db.prepare('SELECT * FROM status_page_items WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(item);
});

// DELETE /api/v1/status-pages/:id/items/:itemId
statusPagesRouter.delete('/status-pages/:id/items/:itemId', (req, res) => {
  const db = getDb();
  const itemId = Number(req.params.itemId);

  const existing = db.prepare('SELECT id FROM status_page_items WHERE id = ? AND status_page_id = ?').get(itemId, Number(req.params.id));
  if (!existing) { res.status(404).json({ error: 'Item not found' }); return; }

  db.prepare('DELETE FROM status_page_items WHERE id = ?').run(itemId);
  res.json({ message: 'Item removed' });
});

// PUT /api/v1/status-pages/:id/items — bulk reorder items
statusPagesRouter.put('/status-pages/:id/items', (req, res) => {
  const db = getDb();
  const pageId = Number(req.params.id);
  const { items } = req.body; // [{id, sort_order}]

  if (!Array.isArray(items)) { res.status(400).json({ error: 'items array required' }); return; }

  const update = db.prepare('UPDATE status_page_items SET sort_order = ? WHERE id = ? AND status_page_id = ?');
  const batch = db.transaction((entries: { id: number; sort_order: number }[]) => {
    for (const entry of entries) {
      update.run(entry.sort_order, entry.id, pageId);
    }
  });
  batch(items);

  const updated = db.prepare('SELECT * FROM status_page_items WHERE status_page_id = ? ORDER BY sort_order ASC').all(pageId);
  res.json(updated);
});
