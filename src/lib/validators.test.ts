import { describe, expect, it } from "vitest";
import { validate } from "./validators";

const acc = { status: "ACTIVE" as const, platform: "YOUTUBE" as const, handle: "x" };
const v = { size: BigInt(8_000_000), durationSec: 70, width: 1080, height: 1920, videoCodec: "h264", probeError: null, probedAt: new Date() };

describe("validate", () => {
  it("passes a 70 s vertical Short", () => {
    expect(validate({ format: "YT_SHORT", account: acc, version: v, caption: "c", title: "t" })).toEqual([]);
  });
  it("rejects a 4-minute Short and a lost account", () => {
    const r = validate({ format: "YT_SHORT", account: { ...acc, status: "NEEDS_RECONNECT" }, version: { ...v, durationSec: 240 }, caption: "c", title: "t" });
    expect(r.length).toBe(2);
  });
  it("Reels needs at least 3 s", () => {
    expect(validate({ format: "IG_REEL", account: { ...acc, platform: "INSTAGRAM" }, version: { ...v, durationSec: 2 }, caption: "c" })).toHaveLength(1);
  });
});
