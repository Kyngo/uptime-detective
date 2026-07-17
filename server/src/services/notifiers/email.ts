import nodemailer from 'nodemailer';
import type { NotificationPayload } from './dispatcher.js';

export interface EmailConfig {
  to: string;
  from?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_pass?: string;
  smtp_secure?: boolean;
}

export async function sendEmail(config: EmailConfig, payload: NotificationPayload): Promise<void> {
  const host = config.smtp_host || process.env.SMTP_HOST;
  const port = config.smtp_port || parseInt(process.env.SMTP_PORT || '587', 10);
  const user = config.smtp_user || process.env.SMTP_USER;
  const pass = config.smtp_pass || process.env.SMTP_PASS;
  const from = config.from || process.env.SMTP_FROM || 'Uptime Detective <noreply@localhost>';

  if (!host) throw new Error('SMTP not configured (no host)');

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: config.smtp_secure ?? port === 465,
    auth: user ? { user, pass } : undefined,
  });

  const isDown = payload.event === 'down';
  const emoji = isDown ? '🔴' : '🟢';
  const statusText = isDown ? 'DOWN' : 'RECOVERED';

  const subject = `${emoji} [${statusText}] ${payload.monitor_name}`;

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${isDown ? '#fee2e2' : '#d1fae5'}; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <h2 style="margin: 0; color: ${isDown ? '#991b1b' : '#065f46'};">
          ${emoji} ${payload.monitor_name} is ${statusText}
        </h2>
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr><td style="padding: 8px 0; color: #666;">Monitor</td><td style="padding: 8px 0;">${payload.monitor_name}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Type</td><td style="padding: 8px 0;">${payload.monitor_type.toUpperCase()}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Target</td><td style="padding: 8px 0;">${payload.target}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Status</td><td style="padding: 8px 0; font-weight: bold; color: ${isDown ? '#dc2626' : '#16a34a'};">${statusText}</td></tr>
        ${payload.message ? `<tr><td style="padding: 8px 0; color: #666;">Message</td><td style="padding: 8px 0;">${payload.message}</td></tr>` : ''}
        ${payload.response_time ? `<tr><td style="padding: 8px 0; color: #666;">Response Time</td><td style="padding: 8px 0;">${payload.response_time}ms</td></tr>` : ''}
        <tr><td style="padding: 8px 0; color: #666;">Time</td><td style="padding: 8px 0;">${payload.timestamp}</td></tr>
      </table>
      <p style="margin-top: 24px; font-size: 12px; color: #999;">Sent by Uptime Detective</p>
    </div>
  `;

  await transporter.sendMail({ from, to: config.to, subject, html });
}
