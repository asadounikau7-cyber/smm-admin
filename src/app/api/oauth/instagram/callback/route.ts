import { loadIntegrationKeys } from "@/lib/integrationKeys";
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { finishOAuth } from "@/lib/oauthState";
import { igExchange } from "@/lib/adapters/instagram";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { encryptJson } from "@/lib/crypto";
import { audit } from "@/lib/audit";

const back = (q: string) => NextResponse.redirect(`${env().APP_URL}/accounts?${q}`);

export async function GET(req: Request) {
  await loadIntegrationKeys();
  const user = await requireOwner();
  const u = new URL(req.url);
  if (u.searchParams.get("error")) return back("err=" + encodeURIComponent("Instagram: " + (u.searchParams.get("error_description") ?? u.searchParams.get("error"))));
  const st = await finishOAuth("instagram", u.searchParams.get("state"));
  if (!st) return back("err=" + encodeURIComponent("Проверка state не прошла, попробуйте ещё раз"));
  try {
    const code = (u.searchParams.get("code") ?? "").replace(/#_$/, "");
    const { creds, me } = await igExchange(code);
    if (me.account_type && !["BUSINESS", "MEDIA_CREATOR"].includes(me.account_type))
      return back("err=" + encodeURIComponent("Нужен профессиональный аккаунт Instagram (Business или Creator)"));
    const externalId = String(me.user_id);
    const a = await db.socialAccount.upsert({
      where: { platform_externalId: { platform: "INSTAGRAM", externalId } },
      update: { credentials: encryptJson(creds), status: "ACTIVE", lastError: null, handle: me.username, tokenExpiresAt: new Date(creds.expires_at) },
      create: { platform: "INSTAGRAM", externalId, handle: me.username, credentials: encryptJson(creds), tokenExpiresAt: new Date(creds.expires_at) },
    });
    await db.publicationJob.updateMany({
      where: { accountId: a.id, status: "ACTION_REQUIRED", errorCode: "AUTH", scheduledAt: { gt: new Date() } },
      data: { status: "QUEUED", errorCode: null, errorMessage: null, attemptCount: 0, nextAttemptAt: null },
    });
    await audit("account.connect", "SocialAccount", a.id, user.id, { platform: "INSTAGRAM", userId: externalId });
    return back("ok=" + encodeURIComponent(`Подключено: @${me.username}`));
  } catch (e) {
    return back("err=" + encodeURIComponent((e as Error).message.slice(0, 300)));
  }
}
