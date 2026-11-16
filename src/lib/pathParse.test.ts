import { describe, expect, it } from "vitest";
import { parseObjectKey } from "./pathParse";

describe("parseObjectKey", () => {
  it("production layout: originals/<source>/<lang>/<id>/episodes/ep-0001.mp4", () => {
    expect(parseObjectKey("originals/yourchannel/en/639846/episodes/ep-0004.mp4")).toMatchObject({
      seriesSlug: "639846", season: 1, episode: 4, language: "en", kind: "FULL_EPISODE", complete: true,
    });
  });
  it("spec example: releases/show-a/s01/e03/en/teaser-01.mp4", () => {
    expect(parseObjectKey("releases/show-a/s01/e03/en/teaser-01.mp4")).toMatchObject({
      seriesSlug: "show-a", season: 1, episode: 3, language: "en", kind: "TEASER", variant: "01", complete: true,
    });
  });
  it("series-level teaser in the production layout", () => {
    expect(parseObjectKey("originals/yourchannel/es/639846/teasers/teaser-a.mp4")).toMatchObject({ kind: "TEASER", language: "es", complete: true });
  });
  it("unknown file needs manual mapping", () => {
    expect(parseObjectKey("misc/random.mp4").complete).toBe(false);
  });
});
