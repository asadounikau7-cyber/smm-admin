import type { Platform, SocialAccount } from "@prisma/client";
import type { PlatformAdapter } from "./types";
import { youtube } from "./youtube";
import { instagram } from "./instagram";
import { uploadPostInstagram, uploadPostTikTok } from "./uploadpost";

/** Manual TikTok: nothing is sent; the owner schedules it in TikTok Studio from the package.
 * tiktokMode "PARTNER" means Upload-Post on both TikTok and Instagram accounts. */
export function adapterFor(account: Pick<SocialAccount, "platform" | "tiktokMode">): PlatformAdapter | null {
  const map: Record<Platform, PlatformAdapter | null> = {
    YOUTUBE: youtube,
    // An Instagram account added with an Upload-Post profile posts through it; one connected by Meta OAuth uses the API.
    INSTAGRAM: account.tiktokMode === "PARTNER" ? uploadPostInstagram : instagram,
    TIKTOK: account.tiktokMode === "PARTNER" ? uploadPostTikTok : null,
  };
  return map[account.platform];
}
