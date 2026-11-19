import { db } from "./db";

const ES_WORDS = new Set(["el", "la", "los", "las", "del", "con", "por", "para", "una", "que", "su", "sus"]);

/** Spanish title guess: Spanish-only letters or Spanish function words ("Fiancé" alone is not enough). */
export function looksSpanish(title: string) {
  if (/[ñ¿¡áíóú]/i.test(title)) return true;
  const words = title.toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.some((w) => ES_WORDS.has(w))) return true;
  // "mi" in the middle of a title with Spanish é: "Adopté a mi némesis…"
  return /é/i.test(title) && words.slice(0, -1).includes("mi");
}

/** Marks series whose language nobody set yet. A person's choice ("en" or "es") is never overwritten. */
export async function markSpanishSeries() {
  const open = await db.series.findMany({ where: { contentLang: null }, select: { id: true, title: true } });
  const es = open.filter((s) => looksSpanish(s.title)).map((s) => s.id);
  if (es.length) await db.series.updateMany({ where: { id: { in: es } }, data: { contentLang: "es" } });
  return es.length;
}
