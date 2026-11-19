/**
 * Opening a private upload at its slot: YouTube's own publishAt, then the API, then a Studio task for a person.
 * YouTube's API answers are faked; notifications go to the dev database.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { encryptJson } from "../crypto";
import { youtube as youtubeAdapter } from "./youtube";
import type { JobCtx } from "./types";

const VID = "vid_open_test";
const account = { id: "acc_open_test", handle: "main_test", credentials: encryptJson({ access_token: "tok", refresh_token: "ref", expires_at: Date.now() + 3600_000 }) };
const job = (over: Partial<JobCtx> = {}) =>
  ({ id: "job_open_test", externalId: VID, visibility: "PUBLIC", scheduledAt: new Date(Date.now() - 60_000), meta: {}, account, ...over }) as unknown as JobCtx;

/** YouTube that keeps `privacy` and, if `apiCanOpen`, accepts visibility changes through PUT. */
function fakeYouTube(st: { privacy: string; publishAt?: string; apiCanOpen?: boolean }) {
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!String(url).includes("/youtube/v3/videos")) throw new Error(`unexpected fetch ${url}`);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      if (st.apiCanOpen) st.privacy = body.status.privacyStatus;
      return Response.json(body);
    }
    return Response.json({ items: [{ id: VID, status: { uploadStatus: "processed", privacyStatus: st.privacy, ...(st.publishAt ? { publishAt: st.publishAt } : {}) } }] });
  });
  return puts;
}

const note = () => db.notification.findUnique({ where: { dedupKey: "studio:job_open_test" } });

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await db.notification.deleteMany({ where: { dedupKey: "studio:job_open_test" } });
  await db.auditEvent.deleteMany({ where: { entityId: "job_open_test" } });
  await db.$disconnect();
});

describe("YouTube: opening a private upload at its slot", () => {
  it("YouTube published it itself → PUBLISHED, no API call", async () => {
    const puts = fakeYouTube({ privacy: "public" });
    const out = await youtubeAdapter.reconcile(job(), {});
    expect(out.status).toBe("PUBLISHED");
    expect(puts).toHaveLength(0);
  });

  it("slot not reached yet → waits, does not touch the video", async () => {
    const puts = fakeYouTube({ privacy: "private", publishAt: new Date(Date.now() + 3600_000).toISOString() });
    const out = await youtubeAdapter.reconcile(job({ scheduledAt: new Date(Date.now() + 3600_000) }), {});
    expect(out.status).toBe("PROCESSING");
    expect(out.recheckInSec).toBe(900);
    expect(puts).toHaveLength(0);
  });

  it("locked private after the slot, API can open → opened via API, PUBLISHED", async () => {
    const puts = fakeYouTube({ privacy: "private", apiCanOpen: true });
    const out = await youtubeAdapter.reconcile(job(), {});
    expect(puts).toHaveLength(1);
    expect(out.status).toBe("PUBLISHED");
    expect(out.state).toMatchObject({ apiOpenTried: true, apiOpenResult: "public" });
  });

  it("API can't open → Studio task once, then PUBLISHED when a person opens it", async () => {
    await db.notification.deleteMany({ where: { dedupKey: "studio:job_open_test" } });
    const st = { privacy: "private" };
    const puts = fakeYouTube(st);
    const first = await youtubeAdapter.reconcile(job(), {});
    expect(puts).toHaveLength(1);
    expect(first.status).toBe("PROCESSING");
    expect(first.state).toMatchObject({ apiOpenTried: true, manualOpen: true });
    expect(first.note).toContain(`https://studio.youtube.com/video/${VID}/edit`);
    expect((await note())?.resolved).toBe(false);

    const state = first.state!;
    const again = await youtubeAdapter.reconcile(job({ meta: { adapter: state } as never }), state);
    expect(again.status).toBe("PROCESSING");
    expect(puts).toHaveLength(1); // no second API try

    st.privacy = "public";
    const done = await youtubeAdapter.reconcile(job({ meta: { adapter: state } as never }), state);
    expect(done.status).toBe("PUBLISHED");
    expect((await note())?.resolved).toBe(true);
  });
});
