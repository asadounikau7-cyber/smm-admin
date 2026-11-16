import type { AssetVersion, PostFormat, SocialAccount } from "@prisma/client";

/**
 * Platform limits used before approval and again right before sending.
 * Bump the version when a platform changes its rules; the version is stored on each job.
 */
export const VALIDATORS = {
  YT_VIDEO: { version: "yt-2026-11", maxSec: 12 * 3600, maxBytes: 256 * 1024 ** 3, titleMax: 100, captionMax: 5000 },
  YT_SHORT: { version: "yt-2026-11", maxSec: 180, maxBytes: 256 * 1024 ** 3, titleMax: 100, captionMax: 5000, vertical: true },
  IG_REEL: { version: "ig-2026-11", minSec: 3, maxSec: 900, maxBytes: 1024 ** 3, captionMax: 2200, hashtagsMax: 30 },
  TT_VIDEO: { version: "tt-2026-11", minSec: 3, maxSec: 600, maxBytes: 4 * 1024 ** 3, captionMax: 2200 },
} as const;

export const FORMAT_PLATFORM: Record<PostFormat, "YOUTUBE" | "INSTAGRAM" | "TIKTOK"> = {
  YT_VIDEO: "YOUTUBE",
  YT_SHORT: "YOUTUBE",
  IG_REEL: "INSTAGRAM",
  TT_VIDEO: "TIKTOK",
};

export const FORMAT_LABEL: Record<PostFormat, string> = {
  YT_VIDEO: "YouTube видео",
  YT_SHORT: "YouTube Shorts",
  IG_REEL: "Instagram Reels",
  TT_VIDEO: "TikTok",
};

export type CheckInput = {
  format: PostFormat;
  account: Pick<SocialAccount, "status" | "platform" | "handle">;
  version: (Pick<AssetVersion, "size" | "durationSec" | "width" | "height" | "videoCodec" | "probeError" | "probedAt"> & { deleted?: boolean }) | null;
  caption: string;
  title?: string | null;
  rightsRequired?: boolean;
  rightsConfirmed?: boolean;
  ambiguousTime?: boolean;
  missingTime?: boolean;
};

export function validate(i: CheckInput): string[] {
  const r: string[] = [];
  const v = VALIDATORS[i.format];
  if (i.account.platform !== FORMAT_PLATFORM[i.format]) r.push("Формат не соответствует площадке аккаунта");
  if (i.account.status === "NEEDS_RECONNECT") r.push(`Нет доступа к @${i.account.handle}: требуется переподключение`);
  if (i.account.status === "DISABLED") r.push(`Аккаунт @${i.account.handle} отключён`);
  if (!i.version) r.push("Нет файла");
  else {
    if (i.version.deleted) r.push("Исходный файл удалён из B2");
    if (!i.version.probedAt) r.push("Файл ещё не проверен (ffprobe)");
    else if (i.version.probeError) r.push("Файл не читается: " + i.version.probeError.slice(0, 120));
    else {
      const d = i.version.durationSec ?? 0;
      if ("minSec" in v && d < v.minSec) r.push(`Слишком короткое видео: ${d.toFixed(0)} с (мин. ${v.minSec})`);
      if (d > v.maxSec) r.push(`Слишком длинное видео: ${Math.round(d)} с (макс. ${v.maxSec})`);
      if (Number(i.version.size) > v.maxBytes) r.push("Файл больше лимита площадки");
      if ("vertical" in v && i.version.width && i.version.height && i.version.width > i.version.height)
        r.push("Для Shorts нужно вертикальное или квадратное видео");
      if (i.format !== "YT_VIDEO" && i.version.videoCodec && !["h264", "hevc"].includes(i.version.videoCodec))
        r.push(`Кодек ${i.version.videoCodec} не поддерживается, нужно перекодирование`);
    }
  }
  if (i.caption.length > v.captionMax) r.push(`Подпись длиннее ${v.captionMax} символов`);
  if ("hashtagsMax" in v && (i.caption.match(/#\S+/g)?.length ?? 0) > v.hashtagsMax) r.push(`Больше ${v.hashtagsMax} хештегов`);
  if ("titleMax" in v) {
    if (!i.title) r.push("Не заполнен заголовок");
    else if (i.title.length > v.titleMax) r.push(`Заголовок длиннее ${v.titleMax} символов`);
  }
  if (i.rightsRequired && !i.rightsConfirmed) r.push("Права на материал не подтверждены");
  if (i.ambiguousTime) r.push("Время попадает на переход часов (повторяется) — подтвердите время");
  if (i.missingTime) r.push("Время не существует из-за перехода на летнее время — выберите другое");
  return r;
}
