/**
 * Unit tests for shared Telegram formatting helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  asMonitorStatus,
  escapeHtml,
  escapeMarkdownV2,
  formatDuration,
  formatRelativeTime,
  formatStatus,
  monitorRef,
  shorten,
  splitMessage,
  statusEmoji,
} from '../../src/services/telegram/format.js';

describe('telegram format', () => {
  describe('escapeHtml', () => {
    it('escapes the three HTML special characters', () => {
      expect(escapeHtml('<b>Tom & Jerry</b>')).toBe('&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;');
    });

    it('leaves normal text untouched', () => {
      expect(escapeHtml('My API v2 (#3)')).toBe('My API v2 (#3)');
    });
  });

  describe('escapeMarkdownV2', () => {
    it('escapes MarkdownV2 reserved characters', () => {
      expect(escapeMarkdownV2('a_b*c[d](e)')).toBe('a\\_b\\*c\\[d\\]\\(e\\)');
    });

    it('escapes backslashes and punctuation', () => {
      expect(escapeMarkdownV2('50% off!')).toBe('50% off\\!');
      expect(escapeMarkdownV2('a\\b')).toBe('a\\\\b');
    });
  });

  describe('formatDuration', () => {
    it('formats seconds, minutes, hours and days', () => {
      expect(formatDuration(45_000)).toBe('45s');
      expect(formatDuration(90_000)).toBe('1m 30s');
      expect(formatDuration(3_600_000)).toBe('1h');
      expect(formatDuration(3_725_000)).toBe('1h 2m');
      expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    });

    it('handles invalid values', () => {
      expect(formatDuration(0)).toBe('0s');
      expect(formatDuration(-5)).toBe('0s');
      expect(formatDuration(Number.NaN)).toBe('0s');
    });
  });

  describe('formatRelativeTime', () => {
    const now = Date.parse('2026-11-06T10:00:00.000Z');

    it('formats past timestamps', () => {
      expect(formatRelativeTime('2026-11-06T09:57:00.000Z', now)).toBe('3m ago');
    });

    it('formats future timestamps', () => {
      expect(formatRelativeTime('2026-11-06T12:00:00.000Z', now)).toBe('2h from now');
    });

    it('handles missing and invalid timestamps', () => {
      expect(formatRelativeTime(null, now)).toBe('never');
      expect(formatRelativeTime('not-a-date', now)).toBe('unknown');
      expect(formatRelativeTime('2026-11-06T10:00:05.000Z', now)).toBe('just now');
    });
  });

  describe('splitMessage', () => {
    it('returns short text unchanged', () => {
      expect(splitMessage('hello', 100)).toEqual(['hello']);
    });

    it('splits on line boundaries under the limit', () => {
      const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      const chunks = splitMessage(text, 200);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
      expect(chunks.join('\n')).toBe(text);
    });

    it('hard-wraps a single long line', () => {
      const chunks = splitMessage('x'.repeat(25), 10);
      expect(chunks).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
    });
  });

  describe('small helpers', () => {
    it('maps statuses to emoji and labels', () => {
      expect(statusEmoji('up')).toBe('🟢');
      expect(statusEmoji('down')).toBe('🔴');
      expect(statusEmoji('degraded')).toBe('🟡');
      expect(statusEmoji('maintenance')).toBe('🔵');
      expect(statusEmoji('unknown')).toBe('⚪');
      expect(formatStatus('down')).toBe('🔴 DOWN');
    });

    it('shortens text', () => {
      expect(shorten('short', 20)).toBe('short');
      expect(shorten('a-very-long-name-that-does-not-fit', 10)).toBe('a-very-lo…');
    });

    it('formats monitor references and narrows statuses', () => {
      expect(monitorRef({ id: 12, name: 'My API' })).toBe('#12 My API');
      expect(asMonitorStatus('up')).toBe('up');
      expect(asMonitorStatus('bogus')).toBe('pending');
    });
  });
});
