import { db } from "@/lib/db";
import { env, b2Configured } from "@/lib/env";
import { requireUser } from "@/lib/auth";
import { Flash, PageHeader } from "@/components/ui";
import { changeMyPasswordAction, createUserAction, deleteUserAction, saveSettingsAction } from "@/app/actions";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const [users, settings] = await Promise.all([db.user.findMany({ orderBy: { createdAt: "asc" } }), db.setting.findMany()]);
  const get = (k: string) => settings.find((x) => x.key === k)?.value;
  const e = env();
  const check = (ok: boolean) => (ok ? <span className="text-green-600">настроено</span> : <span className="muted">не настроено</span>);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Настройки" />
      <Flash msg={sp.ok} />
      <Flash msg={sp.err} kind="err" />

      <form action={changeMyPasswordAction} className="card grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="sm:col-span-3 font-medium">Мой пароль ({me.email})</div>
        <div><label className="label">Текущий пароль</label><input name="current" type="password" required className="input" autoComplete="current-password" /></div>
        <div><label className="label">Новый пароль (4+)</label><input name="password" type="password" required minLength={4} className="input" autoComplete="new-password" /></div>
        <button className="btn btn-primary">Сменить</button>
      </form>

      <form action={saveSettingsAction} className="card space-y-3 p-4">
        <h2 className="font-medium">Публикация</h2>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requireRights" defaultChecked={Boolean(get("requireRights"))} /> Требовать отметку «права подтверждены» перед публикацией</label>
        <div className="max-w-xs"><label className="label">Лимит загрузок YouTube в сутки (квота API)</label><input name="youtubeDailyUploads" type="number" defaultValue={Number(get("youtubeDailyUploads") ?? 6)} className="input" /></div>
        <p className="text-xs muted">Окно догоняющей публикации: {e.CATCHUP_WINDOW_MIN} мин (CATCHUP_WINDOW_MIN). Базовый часовой пояс: {e.BASE_TIMEZONE}.</p>
        <button className="btn btn-primary" disabled={me.role !== "OWNER"}>Сохранить</button>
      </form>

      <div className="card p-4 text-sm">
        <h2 className="mb-2 font-medium">Интеграции (из .env)</h2>
        <ul className="space-y-1">
          <li>Каталог B2 (публичный реестр): {check(Boolean(e.B2_REGISTRY_URL))}</li>
          <li>Ключ B2 (S3 API): {check(b2Configured())}</li>
          <li>YouTube (Google OAuth): {check(Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET))}</li>
          <li>Instagram (Instagram Login): {check(Boolean(e.INSTAGRAM_APP_ID && e.INSTAGRAM_APP_SECRET))}</li>
          <li>TikTok через Upload-Post: {check(Boolean(e.UPLOAD_POST_API_KEY))}</li>
          <li>Email-уведомления: {check(Boolean(e.SMTP_URL && e.NOTIFY_EMAILS))} {e.NOTIFY_EMAILS && <span className="muted">→ {e.NOTIFY_EMAILS}</span>}</li>
        </ul>
      </div>

      <div className="card p-4">
        <h2 className="mb-2 font-medium">Пользователи</h2>
        <ul className="mb-4 space-y-1 text-sm">
          {users.map((u) => (
            <li key={u.id} className="flex items-center gap-2">
              <span className="flex-1">{u.email} <span className="muted">· {u.role === "OWNER" ? "владелец" : "оператор"}</span></span>
              {me.role === "OWNER" && u.id !== me.id && (
                <form action={deleteUserAction}><input type="hidden" name="id" value={u.id} /><button className="btn btn-sm btn-danger">Удалить</button></form>
              )}
            </li>
          ))}
        </ul>
        {me.role === "OWNER" && (
          <form action={createUserAction} className="grid gap-2 md:grid-cols-4 md:items-end">
            <div><label className="label">Email</label><input name="email" type="email" required className="input" /></div>
            <div><label className="label">Пароль (4+)</label><input name="password" type="password" required minLength={4} className="input" /></div>
            <div>
              <label className="label">Роль</label>
              <select name="role" className="input"><option value="OPERATOR">Оператор</option><option value="OWNER">Владелец</option></select>
            </div>
            <button className="btn">Добавить / сменить пароль</button>
          </form>
        )}
      </div>
    </div>
  );
}
