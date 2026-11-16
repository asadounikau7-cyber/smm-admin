import { describe, expect, it } from "vitest";
import { resolveSlot, weekStartFor } from "./time";

const TZ = "America/Winnipeg";
// tzdata 2026e: Manitoba stays on UTC-5 all year, so DST edge cases are tested on Chicago.
const DST_TZ = "America/Chicago";

describe("resolveSlot", () => {
  it("stores UTC for a normal winter slot", () => {
    const ws = weekStartFor(new Date("2026-11-18T12:00:00Z"), TZ); // week of Mon 2026-11-16
    const r = resolveSlot(ws, { weekday: 2, time: "19:00" }, TZ);
    expect(r.local).toBe("2026-11-17 19:00");
    expect(r.utc.toISOString()).toBe("2026-11-18T00:00:00.000Z"); // Winnipeg = UTC-5 year-round
    expect(r.ambiguous || r.missing).toBe(false);
  });
  it("flags a slot that doesn't exist (spring forward, 2027-03-14 02:30)", () => {
    const ws = weekStartFor(new Date("2027-03-10T12:00:00Z"), DST_TZ);
    const r = resolveSlot(ws, { weekday: 7, time: "02:30" }, DST_TZ);
    expect(r.missing).toBe(true);
  });
  it("flags an ambiguous slot (fall back, 2027-11-07 01:30)", () => {
    const ws = weekStartFor(new Date("2027-11-03T12:00:00Z"), DST_TZ);
    const r = resolveSlot(ws, { weekday: 7, time: "01:30" }, DST_TZ);
    expect(r.ambiguous).toBe(true);
  });
});
