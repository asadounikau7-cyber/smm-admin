import type { Platform, SocialAccount } from "@prisma/client";
import type { PlatformAdapter } from "./types";
import { youtube } from "./youtube";
import { instagram } from "./instagram";
import { uploadPostTikTok } from "./uploadpost";

/** Manual TikTok: nothing is sent; the owner schedules it in TikTok Studio from the package. */
export function adapterFor(account: Pick<SocialAccount, "platform" | "tiktokMode">): PlatformAdapter | null {
  const map: Record<Platform, PlatformAdapter | null> = {
    YOUTUBE: youtube,
    INSTAGRAM: instagram,
    TIKTOK: account.tiktokMode === "PARTNER" ? uploadPostTikTok : null,
  };
  return map[account.platform];
}
