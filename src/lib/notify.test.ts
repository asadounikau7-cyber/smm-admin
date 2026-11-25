import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db";
import { classifyHttp } from "./adapters/types";
import { errorSignature, flushEmails, notify } from "./notify";
import { removalHint } from "./adapters/youtube";

const KEYS = ["nt:job", "nt:outage"];
afterAll(async () => {
  await db.notification.deleteMany({ where: { dedupKey: { in: KEYS } } });
  await db.$disconnect();
});

describe("alerts", () => {
  it("a YouTube removal reason is explained", () => {
    expect(removalHint("This video has been removed for violating YouTube's Terms of Service")).toContain("Условий использования");
    expect(removalHint("Оно было удалено за нарушение Условий использования YouTube.")).toContain("спам");
    expect(removalHint("This video has been removed for violating YouTube's Community Guidelines")).toContain("страйк");
    expect(removalHint(null)).toContain("почту канала");
  });

  it("the same failure on different jobs has one signature", () => {
    const a = errorSignature('Google token: {"error":"invalid_client","error_description":"Client missing a project id."}');
    expect(a).toBe(errorSignature('Google token: {"error":"invalid_client","error_description":"Client missing a project id."}'));
    expect(errorSignature("B2 401 for «639552-S01E02.mp4» after 3 tries")).toBe(errorSignature("B2 401 for «639527-S01E05.mp4» after 4 tries"));
    expect(errorSignature("quota exceeded")).not.toBe(errorSignature("uploadLimitExceeded"));
  });

  it("YouTube's daily upload cap is waited out, not a failure", () => {
    const e = classifyHttp(new Response(null, { status: 400 }), { error: { code: 400, message: "The user has exceeded the number of videos they may upload.", errors: [{ reason: "uploadLimitExceeded" }] } });
    expect(e.kind).toBe("RATE_LIMIT");
    expect(e.retryAfterSec).toBe(4 * 3600);
  });

  it("a single failed job waits for the hourly digest, an outage goes out at once", async () => {
    await db.notification.updateMany({ where: { resolved: false, sentAt: null }, data: { sentAt: new Date() } });
    const now = new Date();
    await notify("nt:job", "transient", "Ошибка публикации: timeout");
    expect(await flushEmails(now)).toBe(0);
    expect(await flushEmails(new Date(now.getTime() + 61 * 60_000))).toBe(1);
    await notify("nt:outage", "outage", "Авария YOUTUBE: 3 задач подряд падают");
    expect(await flushEmails(now)).toBe(1);
    expect((await db.notification.findUniqueOrThrow({ where: { dedupKey: "nt:outage" } })).sentAt).not.toBeNull();
  });
});
