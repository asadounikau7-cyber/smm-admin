import { describe, expect, it } from "vitest";
import { youtubeMeta } from "./ytMeta";

describe("youtubeMeta", () => {
  it("names the part and points to the next one", () => {
    const m = youtubeMeta({ title: "661 Pounds Mother's Revenge", synopsis: null, hashtags: "#revenge" }, { season: 1, number: 1 });
    expect(m.title).toBe("661 Pounds Mother's Revenge | Part 1 #shortdrama");
    expect(m.description).toContain("Part 2 is coming next on the channel");
    expect(m.description).toContain("#shorts #drama #shortdrama #minidrama #dramashorts #revenge");
    expect(m.tags[0]).toBe("661 Pounds Mother's Revenge");
    expect(m.tags.join(",").length).toBeLessThan(500);
  });
  it("keeps long titles within 100 chars", () => {
    const m = youtubeMeta({ title: "A".repeat(120), synopsis: "Plot <b>", hashtags: null }, { season: 2, number: 3 });
    expect(m.title.length).toBeLessThanOrEqual(100);
    expect(m.title.endsWith("| Season 2 Part 3")).toBe(true);
    expect(m.description).toContain("Plot b");
    expect(m.description).not.toMatch(/[<>]/);
  });
  it("puts the hook title first when the series has one", () => {
    const m = youtubeMeta({ title: "Bound To The Cold Tycoon", synopsis: null, hashtags: null, hookTitle: "She Owed Him a Debt—Now the Cold Tycoon Wants Her Instead!" }, { season: 1, number: 2 });
    expect(m.title).toBe("She Owed Him a Debt—Now the Cold Tycoon Wants Her Instead! | Part 2 #shortdrama");
    expect(m.description.startsWith("Bound To The Cold Tycoon | Part 2")).toBe(true);
    expect(m.tags[0]).toBe("Bound To The Cold Tycoon");
  });
});
