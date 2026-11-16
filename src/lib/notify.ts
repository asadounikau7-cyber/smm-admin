import nodemailer from "nodemailer";
import { db } from "./db";
import { env } from "./env";

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

/** Called by the worker: sends unsent notifications as one digest email. */
export async function flushEmails() {
  const e = env();
  const pending = await db.notification.findMany({ where: { resolved: false, sentAt: null }, orderBy: { createdAt: "asc" } });
  if (!pending.length) return 0;
  const to = e.NOTIFY_EMAILS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (!e.SMTP_URL || !to.length) {
    for (const n of pending) console.log(`[notify] ${n.kind}: ${n.message}`);
  } else {
    const t = nodemailer.createTransport(e.SMTP_URL);
    const lines = pending.map((n) => `• ${n.message}${n.count > 1 ? ` (×${n.count})` : ""}\n  ${n.link ? e.APP_URL + n.link : ""}`);
    await t.sendMail({
      from: e.MAIL_FROM ?? "SMM Admin <noreply@localhost>",
      to,
      subject: pending.length === 1 ? `Нужно внимание: ${pending[0].message.slice(0, 80)}` : `Нужно внимание: ${pending.length} событий`,
      text: lines.join("\n\n"),
    });
  }
  await db.notification.updateMany({ where: { id: { in: pending.map((n) => n.id) } }, data: { sentAt: new Date() } });
  return pending.length;
}
