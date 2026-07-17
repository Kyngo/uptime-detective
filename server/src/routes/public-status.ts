import { Router } from 'express';
import { getDb } from '../db/connection.js';
import type { MonitorStatus } from '@uptime-detective/shared';

export const publicStatusRouter = Router();

/**
 * GET /api/v1/status/:slug
 * Public endpoint — no auth. Returns status page data with live monitor statuses.
 */
publicStatusRouter.get('/status/:slug', (req, res) => {
  const db = getDb();
  const { slug } = req.params;

  const page = db.prepare('SELECT * FROM status_pages WHERE slug = ? AND is_public = 1').get(slug) as any;
  if (!page) { res.status(404).json({ error: 'Status page not found' }); return; }

  // Get items with their associated data
  const items = db.prepare('SELECT * FROM status_page_items WHERE status_page_id = ? ORDER BY sort_order ASC').all(page.id) as any[];

  const sections: any[] = [];

  for (const item of items) {
    if (item.group_id) {
      // Group item — get group + all monitors in it
      const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(item.group_id) as any;
      if (!group) continue;

      const monitors = db.prepare('SELECT * FROM monitors WHERE group_id = ? AND active = 1 ORDER BY name ASC').all(item.group_id) as any[];
      const enrichedMonitors = monitors.map((m: any) => enrichMonitor(db, m));

      sections.push({
        type: 'group',
        group: { id: group.id, name: group.name, description: group.description },
        monitors: enrichedMonitors,
      });
    } else if (item.monitor_id) {
      // Individual monitor item
      const monitor = db.prepare('SELECT * FROM monitors WHERE id = ? AND active = 1').get(item.monitor_id) as any;
      if (!monitor) continue;

      sections.push({
        type: 'monitor',
        monitors: [enrichMonitor(db, monitor)],
      });
    }
  }

  // Calculate overall status
  const allMonitors = sections.flatMap((s) => s.monitors);
  const overallStatus = calculateOverallStatus(allMonitors);

  res.json({
    title: page.title,
    slug: page.slug,
    description: page.description,
    logo_url: page.logo_url,
    custom_css: page.custom_css,
    show_powered_by: Boolean(page.show_powered_by),
    overall_status: overallStatus,
    sections,
    generated_at: new Date().toISOString(),
  });
});

function enrichMonitor(db: any, monitor: any) {
  // Current status from latest check
  const lastCheck = db.prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY created_at DESC LIMIT 1').get(monitor.id) as any;
  const statusMap: Record<number, MonitorStatus> = { 0: 'down', 1: 'up', 2: 'degraded', 3: 'maintenance' };
  const currentStatus: MonitorStatus = lastCheck ? (statusMap[lastCheck.status] || 'down') : 'pending';

  // 90-day uptime
  const uptimeRow = db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as ok
    FROM checks WHERE monitor_id = ? AND created_at >= datetime('now', '-90 days')
  `).get(monitor.id) as { total: number; ok: number };
  const uptime90d = uptimeRow.total > 0 ? Math.round((uptimeRow.ok / uptimeRow.total) * 10000) / 100 : 100;

  // Daily uptime bars (last 90 days)
  const dailyBars = getDailyUptimeBars(db, monitor.id, 90);

  // Recent incidents (last 30 days, resolved)
  const incidents = db.prepare(`
    SELECT started_at, resolved_at, duration_seconds, cause
    FROM incidents WHERE monitor_id = ? AND started_at >= datetime('now', '-30 days')
    ORDER BY started_at DESC LIMIT 10
  `).all(monitor.id);

  return {
    id: monitor.id,
    name: monitor.name,
    type: monitor.type,
    current_status: currentStatus,
    uptime_90d: uptime90d,
    daily_bars: dailyBars,
    incidents,
  };
}

/**
 * Generate daily uptime bars for the last N days.
 * Returns an array of { date, uptime_pct, total_checks } ordered oldest → newest.
 */
function getDailyUptimeBars(db: any, monitorId: number, days: number): any[] {
  const bars = db.prepare(`
    SELECT 
      DATE(created_at) as date,
      COUNT(*) as total,
      SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) as ok
    FROM checks
    WHERE monitor_id = ? AND created_at >= datetime('now', ? || ' days')
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `).all(monitorId, -days) as { date: string; total: number; ok: number }[];

  return bars.map((b) => ({
    date: b.date,
    uptime_pct: b.total > 0 ? Math.round((b.ok / b.total) * 10000) / 100 : 100,
    total_checks: b.total,
  }));
}

function calculateOverallStatus(monitors: any[]): string {
  if (monitors.length === 0) return 'operational';

  const statuses = monitors.map((m) => m.current_status);
  if (statuses.some((s) => s === 'down')) {
    const downCount = statuses.filter((s) => s === 'down').length;
    if (downCount === statuses.length) return 'major_outage';
    return 'partial_outage';
  }
  if (statuses.some((s) => s === 'degraded')) return 'degraded_performance';
  if (statuses.some((s) => s === 'maintenance')) return 'maintenance';
  return 'operational';
}
