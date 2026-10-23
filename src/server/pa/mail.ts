// 每日逾期信(digest.ts)與即時通知(notify.ts)共用的寄件設定。
// 獨立一個檔案:notify.ts 被 parts.ts 引用,而 digest.ts 又引用 parts.ts,放在 digest 裡會繞成一圈。

import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
export const MAIL_FROM = process.env.SMTP_FROM || SMTP_USER;
export const APP_BASE = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");

export const smtpReady = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && MAIL_FROM);

export function mailer() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}
