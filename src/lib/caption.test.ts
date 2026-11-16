import { describe, expect, it } from "vitest";
import { renderCaption } from "./caption";

describe("renderCaption", () => {
  it("substitutes and drops empty lines", () => {
    expect(renderCaption("{title} — S{season}E{episode}\n{cta}\n{hashtags}", { title: "Show", season: 1, episode: 3, hashtags: "#drama" })).toBe("Show — S01E03\n#drama");
  });
  it("series-level teaser drops the episode marker", () => {
    expect(renderCaption("{title} — S{season}E{episode}\n{cta}", { title: "Show", cta: "Watch now" })).toBe("Show\nWatch now");
  });
});
