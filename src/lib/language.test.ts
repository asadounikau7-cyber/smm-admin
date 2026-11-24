import { describe, expect, it } from "vitest";
import { looksSpanish } from "./language";

describe("looksSpanish", () => {
  it("flags Spanish titles", () => {
    for (const t of ["Adopté a mi némesis serpiente", "Comprada por el millonario", "Doble engaño, doble embarazo", "La niña de la suerte", "Ex de la Mafia: Tatuado", "El CEO es su papá", "Enamorada de mi entrenador"])
      expect(looksSpanish(t), t).toBe(true);
  });
  it("leaves English titles alone", () => {
    for (const t of ["A Blind Forbidden Love with My Fiancé’s Uncle", "My Dragon Fiancée", "The CEO's Greatest Mi", "I Inherited My Dead Ex’s Fiancé", "A Clumsy Succubus Won’t Let Me Graduate"])
      expect(looksSpanish(t), t).toBe(false);
  });
});
