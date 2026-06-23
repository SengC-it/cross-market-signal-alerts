import { CONFIG } from "./config.js";
import nodemailer from "nodemailer";

export async function sendEmail({ subject, text }) {
  if (process.env.GMAIL_SMTP_USER && process.env.GMAIL_APP_PASSWORD) {
    return sendWithGmailSmtp({ subject, text });
  }
  if (process.env.RESEND_API_KEY) {
    return sendWithResend({ subject, text });
  }
  if (process.env.SENDGRID_API_KEY) {
    return sendWithSendGrid({ subject, text });
  }
  console.log("Email provider is not configured. Would send:", { subject, text });
  return { skipped: true, reason: "missing_email_provider" };
}

async function sendWithGmailSmtp({ subject, text }) {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_SMTP_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  return transporter.sendMail({
    from: buildEmailFrom(CONFIG.from || process.env.GMAIL_SMTP_USER),
    to: CONFIG.recipient,
    subject,
    text
  });
}

async function sendWithResend({ subject, text }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: buildEmailFrom(CONFIG.from),
      to: [CONFIG.recipient],
      subject,
      text
    })
  });
  if (!response.ok) {
    throw new Error(`Resend email failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function sendWithSendGrid({ subject, text }) {
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: CONFIG.recipient }] }],
      from: parseFrom(buildEmailFrom(CONFIG.from)),
      subject,
      content: [{ type: "text/plain", value: text }]
    })
  });
  if (!response.ok) {
    throw new Error(`SendGrid email failed: ${response.status} ${await response.text()}`);
  }
  return { ok: true };
}

export function buildEmailFrom(from) {
  const configured = from || process.env.GMAIL_SMTP_USER || CONFIG.from;
  const displayName = process.env.EMAIL_FROM_NAME;
  if (!displayName) return configured;
  const parsed = parseFrom(configured);
  return `${displayName} <${parsed.email}>`;
}

export function parseFrom(from) {
  const match = from.match(/^(.*)<(.+)>$/);
  if (!match) return { email: from };
  return { name: match[1].trim(), email: match[2].trim() };
}
