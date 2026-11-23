import { afterEach, describe, expect, it, vi } from "vitest";
import type { SocialAccount } from "@prisma/client";
import { encryptJson } from "../crypto";
import { ytBiggestNamesake, ytCanComment, ytChannelSnapshot } from "./youtube";

const account = { id: "x", handle: "x", credentials: encryptJson({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600_000 }) } as unknown as SocialAccount;
afterEach(() => vi.unstubAllGlobals());

describe("ytChannelSnapshot", () => {
  it("sums likes and comments over public videos and picks the top one", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      const j = (b: object) => new Response(JSON.stringify(b), { status: 200 });
      if (u.includes("/channels?")) return j({ items: [{ statistics: { subscriberCount: "12", viewCount: "340", videoCount: "3" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
      if (u.includes("/playlistItems?")) return j({ items: [{ contentDetails: { videoId: "a" } }, { contentDetails: { videoId: "b" } }, { contentDetails: { videoId: "c" } }] });
      if (u.includes("/videos?"))
        return j({ items: [
          { id: "a", status: { privacyStatus: "public" }, snippet: { title: "A" }, statistics: { viewCount: "100", likeCount: "5", commentCount: "1" } },
          { id: "b", status: { privacyStatus: "public" }, snippet: { title: "B" }, statistics: { viewCount: "240", likeCount: "9" } },
          { id: "c", status: { privacyStatus: "private" }, snippet: { title: "C" }, statistics: { viewCount: "0", likeCount: "50" } },
        ] });
      throw new Error(`unexpected ${u}`);
    });
    const s = await ytChannelSnapshot(account);
    expect(s).toMatchObject({ subscribers: 12, views: 340, videos: 3, likes: 14, comments: 1, publicVideos: 2 });
    expect(s.top).toEqual({ id: "b", title: "B", views: 240 });
  });
});

describe("ytCanComment", () => {
  const acc = (scope?: string) => ({ credentials: encryptJson({ access_token: "t", refresh_token: "r", expires_at: 0, scope }) }) as unknown as SocialAccount;
  it("needs the force-ssl scope; unknown until a token refresh tells", () => {
    expect(ytCanComment(acc())).toBeNull();
    expect(ytCanComment(acc("https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload"))).toBe(false);
    expect(ytCanComment(acc("https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.force-ssl"))).toBe(true);
  });
});

describe("ytBiggestNamesake", () => {
  it("counts only videos whose title carries the series name", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      const j = (b: object) => new Response(JSON.stringify(b), { status: 200 });
      if (u.includes("/search?")) return j({ items: [{ id: { videoId: "a" } }, { id: { videoId: "b" } }, { id: { videoId: "c" } }] });
      if (u.includes("/videos?"))
        return j({ items: [
          { id: "a", snippet: { title: "Crimson Cage FULL drama", channelTitle: "Big" }, statistics: { viewCount: "450000" } },
          { id: "b", snippet: { title: "Totally unrelated megahit", channelTitle: "Huge" }, statistics: { viewCount: "9000000" } },
          { id: "c", snippet: { title: "crimson cage ep 2", channelTitle: "Small" }, statistics: { viewCount: "1200" } },
        ] });
      throw new Error(`unexpected ${u}`);
    });
    const r = await ytBiggestNamesake(account, "Crimson Cage");
    expect(r.views).toBe(450000);
    expect(r.top).toContain("Big");
  });
});
