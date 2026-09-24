import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport;

export function mailConfigured() {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.pass && config.smtp.from);
}

export async function sendMail({ to, subject, html, text }) {
  if (!mailConfigured()) throw new Error('SMTP_USER / SMTP_PASSWORD / SMTP_FROM are not set');
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transport.sendMail({ from: `ArchJobs <${config.smtp.from}>`, to, subject, html, text });
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
