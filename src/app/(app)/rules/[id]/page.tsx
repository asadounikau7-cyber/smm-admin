import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { Flash, PageHeader } from "@/components/ui";
import { FORMAT_LABEL } from "@/lib/validators";
import { WEEKDAYS_RU, type Slot } from "@/lib/time";
import { deleteRuleAction, saveRuleAction } from "@/app/actions";

export default async function RuleForm({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { id } = await params;
  const { err } = await searchParams;
  const rule = id === "new" ? null : await db.releaseRule.findUnique({ where: { id } });
  const [series, accounts, otherRules] = await Promise.all([
    db.series.findMany({ orderBy: [{ active: "desc" }, { title: "asc" }], select: { id: true, title: true, active: true, bannedAt: true } }),
    db.socialAccount.findMany({ where: { status: { not: "DISABLED" } }, orderBy: [{ platform: "asc" }, { handle: "asc" }] }),
    db.releaseRule.findMany({ where: { id: { not: id }, offsetFromRuleId: null }, select: { id: true, name: true } }),
  ]);
  const slots = (rule?.slots as Slot[] | undefined) ?? [];
  const days = new Set(slots.map((s) => s.weekday));
  const times = [...new Set(slots.map((s) => s.time))].join(", ");
  const tpl = rule?.captionTemplate ?? "{title} — S{season}E{episode}\n{cta}\n{hashtags}";

  return (
    <div className="max-w-3xl">
      <PageHeader title={rule ? `Правило: ${rule.name}` : "Новое правило"} />
      <Flash msg={err} kind="err" />
      <form action={saveRuleAction} className="card space-y-4 p-5">
        <input type="hidden" name="id" value={rule?.id ?? ""} />
        <div className="grid gap-3 md:grid-cols-2">
          <div><label className="label">Название</label><input name="name" defaultValue={rule?.name ?? ""} placeholder="Серии на YouTube EN" className="input" required /></div>
          <label className="flex items-center gap-2 pt-5 text-sm"><input type="checkbox" name="enabled" defaultChecked={rule?.enabled ?? true} /> Включено</label>
          <div>
            <label className="label">Сериал</label>
            <select name="seriesId" defaultValue={rule?.seriesId} className="input" required>
              {series.map((s) => <option key={s.id} value={s.id}>{s.bannedAt ? "⛔ INACTIVE · " : s.active ? "● " : ""}{s.title}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Материал</label>
              <select name="assetKind" defaultValue={rule?.assetKind ?? "FULL_EPISODE"} className="input">
                <option value="FULL_EPISODE">Полные серии</option>
                <option value="VERTICAL">Вертикальные версии</option>
                <option value="TEASER">Анонсы</option>
              </select>
            </div>
            <div><label className="label">Язык</label><input name="language" defaultValue={rule?.language ?? "en"} className="input" required /></div>
          </div>
          <div>
            <label className="label">Аккаунт</label>
            <select name="accountId" defaultValue={rule?.accountId} className="input" required>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.platform} · @{a.handle}{a.language ? ` (${a.language})` : ""}</option>)}
            </select>
            {accounts.length === 0 && <p className="mt-1 text-xs text-red-600">Сначала добавьте аккаунт.</p>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Формат</label>
              <select name="format" defaultValue={rule?.format ?? "YT_SHORT"} className="input">
                {Object.entries(FORMAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Видимость</label>
              <select name="visibility" defaultValue={rule?.visibility ?? "PUBLIC"} className="input">
                <option value="PUBLIC">Публично</option>
                <option value="UNLISTED">По ссылке</option>
                <option value="PRIVATE">Приватно</option>
              </select>
            </div>
          </div>
        </div>

        <fieldset className="rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
          <legend className="px-1 text-sm font-medium">Когда</legend>
          <div className="mb-2 flex flex-wrap gap-3">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <label key={d} className="flex items-center gap-1 text-sm"><input type="checkbox" name="weekday" value={d} defaultChecked={days.has(d)} /> {WEEKDAYS_RU[d]}</label>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div><label className="label">Время (через запятую)</label><input name="times" defaultValue={times || "19:00"} className="input" /></div>
            <div><label className="label">Часовой пояс</label><input name="timezone" defaultValue={rule?.timezone ?? env().BASE_TIMEZONE} className="input" /></div>
          </div>
          <p className="my-2 text-xs muted">Или вместо слотов: смещение от выпуска серии по другому правилу (например, анонс за 24 часа).</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">От правила</label>
              <select name="offsetFromRuleId" defaultValue={rule?.offsetFromRuleId ?? ""} className="input">
                <option value="">— не использовать —</option>
                {otherRules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div><label className="label">Смещение, часов (минус = раньше)</label><input name="offsetHours" type="number" step="0.5" defaultValue={rule?.offsetMinutes != null ? rule.offsetMinutes / 60 : -24} className="input" /></div>
          </div>
        </fieldset>

        <div>
          <label className="label">Шаблон подписи: {"{title} {series} {season} {episode} {cta} {hashtags}"}</label>
          <textarea name="captionTemplate" defaultValue={tpl} rows={4} className="input font-mono" />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div><label className="label">CTA</label><input name="cta" defaultValue={rule?.cta ?? ""} placeholder="Watch the next episode on our channel!" className="input" /></div>
          <div><label className="label">Хештеги (иначе — из сериала)</label><input name="hashtags" defaultValue={rule?.hashtags ?? ""} className="input" /></div>
        </div>
        <div className="max-w-xs">
          <label className="label">Публиковать только первые N серий (пусто = все)</label>
          <input type="number" name="maxEpisodes" min={1} defaultValue={rule ? (rule.maxEpisodes ?? "") : 3} className="input" />
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" name="strictOrder" defaultChecked={rule?.strictOrder ?? true} /> Строгий порядок серий</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="requireVariant" defaultChecked={rule?.requireVariant ?? false} /> Только своя версия аккаунта (без версии — не публиковать оригинал)</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="madeForKids" defaultChecked={rule?.madeForKids ?? false} /> Для детей</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="aiDisclosure" defaultChecked={rule?.aiDisclosure ?? false} /> Содержит AI / синтетику</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="paidPromotion" defaultChecked={rule?.paidPromotion ?? false} /> Платное продвижение</label>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary">Сохранить</button>
        </div>
      </form>
      {rule && (
        <form action={deleteRuleAction} className="mt-3">
          <input type="hidden" name="id" value={rule.id} />
          <button className="btn btn-danger btn-sm">Удалить правило</button>
        </form>
      )}
    </div>
  );
}
