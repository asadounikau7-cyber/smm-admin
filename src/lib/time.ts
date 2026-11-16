import { DateTime } from "luxon";

export type Slot = { weekday: number; time: string };

export type ResolvedSlot = {
  utc: Date;
  local: string; // "2026-11-17 19:00"
  timezone: string;
  /// DST: wall-clock time happens twice (fall back) — we take the first, caller must confirm
  ambiguous: boolean;
  /// DST: wall-clock time doesn't exist (spring forward) — shifted forward, caller must confirm
  missing: boolean;
};

/** Monday 00:00 (local) of the week containing `d`, returned as a UTC Date. */
export function weekStartFor(d: Date, tz: string): Date {
  return DateTime.fromJSDate(d, { zone: tz }).startOf("week").toUTC().toJSDate();
}

export function resolveSlot(weekStartUtc: Date, slot: Slot, tz: string): ResolvedSlot {
  const [h, m] = slot.time.split(":").map(Number);
  const monday = DateTime.fromJSDate(weekStartUtc, { zone: tz }).startOf("week");
  const day = monday.plus({ days: slot.weekday - 1 });
  const dt = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour: h, minute: m }, { zone: tz });
  const missing = dt.hour !== h || dt.minute !== m;
  // Fall back: the same wall-clock time also exists one hour before or after.
  const sameWall = (d: DateTime) => d.hour === h && d.minute === m && d.day === dt.day;
  const ambiguous =
    !missing && (sameWall(DateTime.fromMillis(dt.toMillis() + 3600_000, { zone: tz })) || sameWall(DateTime.fromMillis(dt.toMillis() - 3600_000, { zone: tz })));
  return {
    utc: dt.toUTC().toJSDate(),
    local: dt.toFormat("yyyy-LL-dd HH:mm"),
    timezone: tz,
    ambiguous,
    missing,
  };
}

export function toLocal(d: Date, tz: string, fmt = "yyyy-LL-dd HH:mm") {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat(fmt);
}

export function parseLocal(local: string, tz: string): Date {
  return DateTime.fromFormat(local, "yyyy-LL-dd HH:mm", { zone: tz }).toUTC().toJSDate();
}

export const WEEKDAYS_RU = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
