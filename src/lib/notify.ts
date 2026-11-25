import nodemailer from "nodemailer";
import { db } from "./db";
import { env } from "./env";
import { loadIntegrationKeys } from "./integrationKeys";

/**
 * Records a problem that needs the owner. The same dedupKey is merged (count++),
 * and email goes out at most once per hour per key.
 */
export async function notify(dedupKey: string, kind: string, message: string, link?: string) {
  const existing = await db.notification.findUnique({ where: { dedupKey } });
  if (existing && !existing.resolved) {
    await db.notification.update({ where: { dedupKey }, data: { count: { increment: 1 }, message, link } });
    return;
  }
  await db.notification.upsert({
    where: { dedupKey },
    update: { resolved: false, count: 1, message, link, sentAt: null, kind },
    create: { dedupKey, kind, message, link },
  });
}

export async function resolveNotification(dedupKey: string) {
  await db.notification.updateMany({ where: { dedupKey, resolved: false }, data: { resolved: true } });
}

/** The only kinds that are mailed (at once); everything else is shown on «Обзор» only. */
const URGENT = new Set(["outage", "auth", "removal", "sync", "worker"]);

export function recipients() {
  return env().NOTIFY_EMAILS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
}

/** SMTP from .env, or Gmail with an app password entered in Settings (mail goes from the first recipient's Gmail). */
export async function mailer() {
  await loadIntegrationKeys();
  const e = env();
  if (e.SMTP_URL) return { t: nodemailer.createTransport(e.SMTP_URL), from: e.MAIL_FROM ?? "SMM Admin <noreply@localhost>" };
  const user = recipients().find((a) => /@(gmail|googlemail)\.com$/i.test(a));
  if (e.GMAIL_APP_PASSWORD && user)
    return { t: nodemailer.createTransport({ service: "gmail", auth: { user, pass: e.GMAIL_APP_PASSWORD.replace(/\s+/g, "") } }), from: `SMM Admin <${user}>` };
  return null;
}

export async function sendMail(subject: string, text: string) {
  const m = await mailer();
  const to = recipients();
  if (!m || !to.length) throw new Error("почта не настроена: нужен пароль приложения Gmail в Настройках");
  await m.t.sendMail({ from: m.from, to, subject, text });
}

/** Called by the worker: serious problems go out by email at once. */
export async function flushEmails(now = new Date()) {
  // Only serious trouble is mailed (Andrei, 2026-11-25: no hourly digest); the rest stays on «Обзор».
  const pending = await db.notification.findMany({ where: { resolved: false, sentAt: null, kind: { in: [...URGENT] } }, orderBy: { createdAt: "asc" } });
  if (!pending.length) return 0;
  const m = await mailer();
  if (!m || !recipients().length) {
    for (const n of pending) console.log(`[notify] ${n.kind}: ${n.message}`);
  } else {
    const e = env();
    const lines = pending.map((n) => `• ${n.message}${n.count > 1 ? ` (×${n.count})` : ""}${n.link ? `\n  ${e.APP_URL}${n.link}` : ""}`);
    const subject = pending.length === 1 ? `🔴 Админка: ${pending[0].message.slice(0, 90)}` : `🔴 Админка: ${pending.length} серьёзных проблемы`;
    await m.t.sendMail({ from: m.from, to: recipients(), subject, text: `${lines.join("\n\n")}\n\nОбзор: ${e.APP_URL}/` });
  }
  await db.notification.updateMany({ where: { id: { in: pending.map((n) => n.id) } }, data: { sentAt: now } });
  return pending.length;
}

/** An error message with ids, numbers and quotes taken out, so the same failure on different jobs matches. */
export function errorSignature(message: string) {
  return message.replace(/«[^»]*»|"[^"]*"/g, (q) => (/error|invalid|denied|unauthor/i.test(q) ? q : "…")).replace(/\d+/g, "#").slice(0, 120);
}

/**
 * The same error on several different jobs within half an hour is not bad luck but a broken key, token,
 * bucket or server: one urgent email right away instead of a pile of failed jobs found the next day.
 */
export async function checkOutage(platform: string, message: string, now = new Date()) {
  const sig = errorSignature(message);
  const recent = await db.publicationJob.findMany({
    where: { platform: platform as never, errorMessage: { not: null }, updatedAt: { gte: new Date(now.getTime() - 30 * 60_000) } },
    select: { errorMessage: true },
    take: 200,
  });
  const same = recent.filter((j) => errorSignature(j.errorMessage!) === sig).length;
  if (same < 3) return false;
  await notify(
    `outage:${platform}`,
    "outage",
    `Авария ${platform}: ${same} задач подряд падают с одной ошибкой — «${message.slice(0, 160)}». Публикации стоят, нужно чинить`,
    "/",
  );
  return true;
}
