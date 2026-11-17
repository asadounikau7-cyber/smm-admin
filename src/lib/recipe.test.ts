import { describe, expect, it } from "vitest";
import { buildFrame, buildRender, DEFAULT_RECIPE, DEFAULT_VARIATION, generateRecipes, normalizeRecipe, outputDuration, recipeSignature, sourceTimeAt, variantCode, wrapText } from "./recipe";

describe("recipe", () => {
  it("normalizes junk input into a valid recipe", () => {
    const r = normalizeRecipe({ zoom: 9, speed: "abc", preset: "nope", texts: [{ text: "  " }, { text: "hi", color: "red;rm" }], trimStart: 5, trimEnd: 4 });
    expect(r.zoom).toBe(2);
    expect(r.speed).toBe(1);
    expect(r.preset).toBe("none");
    expect(r.texts).toHaveLength(1);
    expect(r.texts[0].color).toBe("white");
    expect(r.trimEnd).toBeNull();
  });

  it("generates the requested number of distinct versions, deterministically", () => {
    const a = generateRecipes(DEFAULT_RECIPE, DEFAULT_VARIATION, 100, "s");
    const b = generateRecipes(DEFAULT_RECIPE, DEFAULT_VARIATION, 100, "s");
    expect(a).toHaveLength(100);
    expect(new Set(a.map((x) => x.signature)).size).toBe(100);
    expect(a.map((x) => x.signature)).toEqual(b.map((x) => x.signature));
    const more = generateRecipes(DEFAULT_RECIPE, DEFAULT_VARIATION, 50, "t", new Set(a.map((x) => x.signature)));
    expect(more.every((x) => !a.some((y) => y.signature === x.signature))).toBe(true);
  });

  it("can't make more versions than the variation allows", () => {
    expect(generateRecipes(DEFAULT_RECIPE, {}, 5, "x")).toHaveLength(1);
  });

  it("signature ignores the cover frame", () => {
    expect(recipeSignature({ ...DEFAULT_RECIPE, coverTime: 3 })).toBe(recipeSignature(DEFAULT_RECIPE));
  });

  it("maps output time to source time with hook, trim and speed", () => {
    const r = normalizeRecipe({ trimStart: 10, speed: 2, hook: { from: 40, length: 2 } });
    expect(sourceTimeAt(r, 0.5, 60)).toBe(41);
    expect(sourceTimeAt(r, 3, 60)).toBe(14);
    expect(outputDuration(r, 60)).toBe((50 + 2) / 2);
  });

  it("caps output length", () => {
    expect(outputDuration(normalizeRecipe({ maxDuration: 30 }), 80)).toBeCloseTo(30);
  });

  it("builds ffmpeg args without user text in them", () => {
    const r = normalizeRecipe({ texts: [{ text: "a:b,'c'; [x] %{pts}", from: 0, to: 2 }], hook: { from: 5, length: 2 } });
    const p = buildRender(r, { durationSec: 60, hasAudio: true });
    expect(p.args.join(" ")).not.toContain("%{pts}");
    expect(p.files["t0.txt"]).toContain("%{pts}");
    expect(p.args).toContain("-map_metadata");
    const f = buildFrame(r, 1, 60);
    expect(f.args).toContain("-ss");
  });

  it("wraps long lines", () => {
    expect(wrapText("one two three four five six seven eight nine ten eleven twelve", 80).split("\n").length).toBeGreaterThan(1);
  });

  it("codes versions readably", () => {
    expect(variantCode("639846", 1, 3, "en", 17)).toBe("639846-S01E03-EN-V017");
  });
});
