import { afterEach, describe, expect, it, vi } from "vitest";
import { setEnvOverrides } from "./env";
import { b2Fetch, b2SignedUrl } from "./b2auth";

const LINK = "https://f005.backblazeb2.com/b2api/v1/b2_download_file_by_id?fileId=4_zabc_f1";
const KEY = "originals/yourchannel/en/639844/episodes/ep 0001.mp4";

afterEach(() => {
  vi.unstubAllGlobals();
  setEnvOverrides({});
});

describe("private B2 bucket by application key", () => {
  it("without a key the link is used as is", async () => {
    setEnvOverrides({ B2_KEY_ID: undefined, B2_APP_KEY: undefined });
    expect(await b2SignedUrl(LINK, "a/b.mp4")).toBe(LINK);
  });

  it("authorizes once, sends the token, renews it after a 401, and signs links for ffmpeg", async () => {
    setEnvOverrides({ B2_KEY_ID: "kid-1", B2_APP_KEY: "secret" });
    let n = 0;
    const calls: { url: string; auth?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      calls.push({ url, auth });
      if (url.includes("b2_authorize_account")) {
        expect(auth).toBe(`Basic ${Buffer.from("kid-1:secret").toString("base64")}`);
        return new Response(
          JSON.stringify({ authorizationToken: `tok${++n}`, accountId: "acc", apiInfo: { storageApi: { apiUrl: "https://api005.backblazeb2.com", downloadUrl: "https://f005.backblazeb2.com", allowed: { buckets: [{ id: "abc", name: "my-bucket" }] } } } }),
          { status: 200 },
        );
      }
      return new Response("x", { status: auth === "tok1" ? 401 : 200 });
    });
    const res = await b2Fetch(LINK);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url === LINK).map((c) => c.auth)).toEqual(["tok1", "tok2"]);
    // By name, so the token can ride in the link (download by id refuses ?Authorization=).
    expect(await b2SignedUrl(LINK, KEY)).toBe("https://f005.backblazeb2.com/file/my-bucket/originals/yourchannel/en/639844/episodes/ep%200001.mp4?Authorization=tok2");
    // Not a B2 link: untouched.
    expect(await b2SignedUrl("https://example.com/a.mp4", KEY)).toBe("https://example.com/a.mp4");
  });
});
