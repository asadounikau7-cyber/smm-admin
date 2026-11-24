import type { Platform, SocialAccount } from "@prisma/client";
import type { PlatformAdapter } from "./types";
import { youtube } from "./youtube";
import { instagram } from "./instagram";
import { uploadPostInstagram, uploadPostTikTok } from "./uploadpost";

/**
 * Posted by hand from a package (file + caption): nothing is sent. TikTok unless it is on Upload-Post;
 * Instagram only when added in manual mode (an Instagram connected by Meta OAuth posts through the API).
 * tiktokMode "PARTNER" means Upload-Post on both TikTok and Instagram accounts.
 */
export function isManual(account: Pick<SocialAccount, "platform" | "tiktokMode">) {
  if (account.platform === "TIKTOK") return account.tiktokMode !== "PARTNER";
  if (account.platform === "INSTAGRAM") return account.tiktokMode === "MANUAL";
  return false;
}

export function adapterFor(account: Pick<SocialAccount, "platform" | "tiktokMode">): PlatformAdapter | null {
  if (isManual(account)) return null;
  const map: Record<Platform, PlatformAdapter | null> = {
    YOUTUBE: youtube,
    // An Instagram account added with an Upload-Post profile posts through it; one connected by Meta OAuth uses the API.
    INSTAGRAM: account.tiktokMode === "PARTNER" ? uploadPostInstagram : instagram,
    TIKTOK: account.tiktokMode === "PARTNER" ? uploadPostTikTok : null,
  };
  return map[account.platform];
}
