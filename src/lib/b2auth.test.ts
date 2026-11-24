import { afterEach, describe, expect, it, vi } from "vitest";
import { setEnvOverrides } from "./env";
import { b2Fetch, b2SignedUrl } from "./b2auth";

const LINK = "https://f005.backblazeb2.com/b2api/v1/b2_download_file_by_id?fileId=4_zabc_f1";

afterEach(() => {
  vi.unstubAllGlobals();
  setEnvOverrides({});
});

describe("private B2 bucket by application key", () => {
  it("without a key the link is used as is", async () => {
    setEnvOverrides({ B2_KEY_ID: undefined, B2_APP_KEY: undefined });
    expect(await b2SignedUrl(LINK)).toBe(LINK);
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
        return new Response(JSON.stringify({ authorizationToken: `tok${++n}` }), { status: 200 });
      }
      return new Response("x", { status: auth === "tok1" ? 401 : 200 });
    });
    const res = await b2Fetch(LINK);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url === LINK).map((c) => c.auth)).toEqual(["tok1", "tok2"]);
    const signed = new URL(await b2SignedUrl(LINK));
    expect(signed.searchParams.get("Authorization")).toBe("tok2");
    expect(signed.searchParams.get("fileId")).toBe("4_zabc_f1");
    // Not a B2 link: untouched.
    expect(await b2SignedUrl("https://example.com/a.mp4")).toBe("https://example.com/a.mp4");
  });
});
