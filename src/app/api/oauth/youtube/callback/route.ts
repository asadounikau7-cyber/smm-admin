import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { finishOAuth } from "@/lib/oauthState";
import { googleExchange } from "@/lib/adapters/youtube";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { encryptJson } from "@/lib/crypto";
import { audit } from "@/lib/audit";

const back = (q: string) => NextResponse.redirect(`${env().APP_URL}/accounts?${q}`);

export async function GET(req: Request) {
  const user = await requireOwner();
  const u = new URL(req.url);
  if (u.searchParams.get("error")) return back("err=" + encodeURIComponent("Google: " + u.searchParams.get("error")));
  const st = await finishOAuth("youtube", u.searchParams.get("state"));
  if (!st) return back("err=" + encodeURIComponent("Проверка state не прошла, попробуйте ещё раз"));
  try {
    const { creds, channels } = await googleExchange(u.searchParams.get("code") ?? "", st.verifier);
    if (!creds.refresh_token) return back("err=" + encodeURIComponent("Google не выдал refresh token: отзовите доступ в настройках Google-аккаунта и подключите снова"));
    if (!channels.length) return back("err=" + encodeURIComponent("У этого Google-аккаунта нет YouTube-канала"));
    const names: string[] = [];
    for (const ch of channels) {
      const handle = (ch.snippet.customUrl ?? ch.snippet.title).replace(/^@/, "");
      // The channel id is the stable identity; reconnecting the same channel updates its tokens.
      const a = await db.socialAccount.upsert({
        where: { platform_externalId: { platform: "YOUTUBE", externalId: ch.id } },
        update: { credentials: encryptJson(creds), status: "ACTIVE", lastError: null, handle, displayName: ch.snippet.title, tokenExpiresAt: new Date(creds.expires_at) },
        create: { platform: "YOUTUBE", externalId: ch.id, handle, displayName: ch.snippet.title, credentials: encryptJson(creds), tokenExpiresAt: new Date(creds.expires_at) },
      });
      await audit("account.connect", "SocialAccount", a.id, user.id, { platform: "YOUTUBE", channelId: ch.id });
      names.push(ch.snippet.title);
      // Jobs paused for a lost token can run again.
      await db.publicationJob.updateMany({
        where: { accountId: a.id, status: "ACTION_REQUIRED", errorCode: "AUTH", scheduledAt: { gt: new Date() } },
        data: { status: "QUEUED", errorCode: null, errorMessage: null, attemptCount: 0, nextAttemptAt: null },
      });
    }
    return back("ok=" + encodeURIComponent("Подключено: " + names.join(", ")));
  } catch (e) {
    return back("err=" + encodeURIComponent((e as Error).message.slice(0, 300)));
  }
}
