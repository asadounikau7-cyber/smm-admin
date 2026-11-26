import { describe, expect, it } from "vitest";
import { childRisk } from "./childSafety";

describe("child safety", () => {
  it("flags series with children in the story by title or hook", () => {
    for (const t of ["Daddy, I finally have a home", "Don't Touch My Son: The Mafia Queen Returns", "Cinderella and the Mafia Twins", "Beware of the Baby Prophet", "Fierce Hot Mom & The Super Tot Protectors", "A Surprise Son：Claimed by My Alpha CEO", "After she leave, I became Cupid's single father", "Can I Stay, Daddy?"])
      expect(childRisk({ title: t }), t).not.toBeNull();
    expect(childRisk({ title: "Emma' s Magic Brush", hookTitle: "A little girl's brush paints her mother's revenge", synopsis: "Six-year-old Emma and her kid brother" })).toBe("kid");
  });
  it("leaves adult romance alone", () => {
    for (const t of ["Diamond Girl, Wild Kingdom", "Claimed by My Ex's Alpha Father", "Every Tycoon Wants Her", "Demon King Crush On His Slave", "Bound To The Cold Tycoon", "Betrayed by the CEO: My Billionaire Mother's Masterplan", "Sonata of Love", "Kidnapped by the Don"])
      expect(childRisk({ title: t }), t).toBeNull();
  });
});

describe("child safety in the database", () => {
  it("takes a child series off and keeps the rest as film candidates", async () => {
    const { db } = await import("./db");
    const { dropChildSeries } = await import("./childSafety");
    const { filmCandidates } = await import("./films");
    const slugs = ["cs-kid", "cs-adult"];
    await db.series.deleteMany({ where: { slug: { in: slugs } } });
    const kid = await db.series.create({ data: { slug: "cs-kid", title: "Don't Touch My Son", stage: "IN_WORK" } });
    const adult = await db.series.create({ data: { slug: "cs-adult", title: "Every Tycoon Wants Her", stage: "IN_WORK" } });
    const out = await dropChildSeries();
    expect(out.some((t) => t.includes("Don't Touch My Son"))).toBe(true);
    const ids = (await db.series.findMany({ where: { ...filmCandidates, slug: { in: slugs } }, select: { id: true } })).map((x) => x.id);
    expect(ids).toEqual([adult.id]);
    expect((await db.series.findUniqueOrThrow({ where: { id: kid.id } })).mainSkip).toContain("Дети в сюжете");
    await db.series.deleteMany({ where: { slug: { in: slugs } } });
    await db.$disconnect();
  });
});
