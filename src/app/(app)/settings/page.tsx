import { db } from "@/lib/db";
import { env, b2Configured, fileEnv } from "@/lib/env";
import { storedIntegrationKeys } from "@/lib/integrationKeys";
import { requireUser } from "@/lib/auth";
import { Flash, PageHeader } from "@/components/ui";
import { getYtTestSettings } from "@/lib/seriesTest";
import { saveYtTestSettingsAction } from "@/app/testActions";
import { changeMyPasswordAction, saveIntegrationKeysAction, createUserAction, deleteUserAction, saveSettingsAction } from "@/app/actions";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const [users, settings] = await Promise.all([db.user.findMany({ orderBy: { createdAt: "asc" } }), db.setting.findMany()]);
  const get = (k: string) => settings.find((x) => x.key === k)?.value;
  const e = env();
  const stored = await storedIntegrationKeys();
  const ytTest = await getYtTestSettings();
  const ytAccounts = await db.socialAccount.findMany({ where: { platform: "YOUTUBE" }, include: { octoProfile: { select: { title: true } } }, orderBy: { handle: "asc" } });
  const ytLabel = (a: (typeof ytAccounts)[number]) => `@${a.handle}${a.octoProfile ? ` · Octo «${a.octoProfile.title}»` : ""}`;
  const fe = fileEnv();
  const KEYS = [
    { k: "GOOGLE_CLIENT_ID", label: "Google Client ID", group: "YouTube" },
    { k: "GOOGLE_CLIENT_SECRET", label: "Google Client Secret", group: "YouTube" },
    { k: "INSTAGRAM_APP_ID", label: "Instagram App ID", group: "Instagram" },
    { k: "INSTAGRAM_APP_SECRET", label: "Instagram App Secret", group: "Instagram" },
    { k: "UPLOAD_POST_API_KEY", label: "Upload-Post API key", group: "TikTok" },
  ] as const;
  const hint = (v?: string) => (v ? `…${v.slice(-4)}` : "");
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

      <form action={saveYtTestSettingsAction} className="card grid gap-3 p-4 md:grid-cols-2">
        <h2 className="md:col-span-2 font-medium">YouTube-тест сериалов</h2>
        <p className="md:col-span-2 text-xs muted">
          Каталог → сериал → «Отправить на тест»: серия уходит на тестовый канал. Если YouTube не отклонил и не заблокировал ролик за время наблюдения, сериал становится «в работе», и в его карточке появляется список серий для ручной загрузки на основной канал.
        </p>
        <div>
          <label className="label">Тестовый канал по умолчанию</label>
          <select name="testAccountId" defaultValue={ytTest.testAccountId ?? ""} className="input">
            <option value="">—</option>
            {ytAccounts.map((a) => <option key={a.id} value={a.id}>{ytLabel(a)}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Основной канал: автозагрузка серии 1 (закрытой, откроется через API или задачей «Открыть в Studio»)</label>
          <select name="launchAccountId" defaultValue={ytTest.launchAccountId ?? ""} className="input">
            <option value="">— вручную —</option>
            {ytAccounts.map((a) => <option key={a.id} value={a.id}>{ytLabel(a)}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Доступ к тестовому ролику</label>
          <select name="visibility" defaultValue={ytTest.visibility} className="input">
            <option value="PRIVATE">Закрытый (рекомендуется)</option>
            <option value="UNLISTED">По ссылке (до аудита Google может остаться закрытым)</option>
            <option value="PUBLIC">Открытый (до аудита Google может остаться закрытым)</option>
          </select>
        </div>
        <div>
          <label className="label">Наблюдать после загрузки, мин</label>
          <input name="waitMin" type="number" min={0} defaultValue={ytTest.waitMin} className="input" />
        </div>
        <div><button className="btn btn-primary" disabled={me.role !== "OWNER"}>Сохранить</button></div>
      </form>

      {me.role === "OWNER" && (
        <form action={saveIntegrationKeysAction} className="card space-y-3 p-4 text-sm">
          <h2 className="font-medium">Ключи площадок</h2>
          <p className="text-xs muted">
            Вставьте ключи сюда, на сервер заходить не нужно. Хранятся в базе в зашифрованном виде. Пустое поле — значение не меняется.
          </p>
          <div className="grid gap-1 rounded-lg p-3 text-xs" style={{ background: "var(--bg)" }}>
            <div>Redirect URI для Google: <code className="select-all">{e.APP_URL}/api/oauth/youtube/callback</code></div>
            <div>Redirect URI для Instagram: <code className="select-all">{e.APP_URL}/api/oauth/instagram/callback</code></div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {KEYS.map(({ k, label, group }) => {
              const fromDb = stored[k];
              const fromFile = fe[k];
              return (
                <div key={k}>
                  <label className="label">
                    {group} · {label}{" "}
                    {fromDb ? <span className="text-green-600">задан здесь {hint(fromDb)}</span> : fromFile ? <span className="text-green-600">задан в .env {hint(fromFile)}</span> : <span>не задан</span>}
                  </label>
                  <input name={k} type={k.endsWith("_ID") ? "text" : "password"} autoComplete="off" className="input" placeholder={fromDb || fromFile ? "оставьте пустым, чтобы не менять" : ""} />
                  {fromDb && (
                    <label className="mt-1 flex items-center gap-1.5 text-xs muted"><input type="checkbox" name={`clear_${k}`} /> удалить</label>
                  )}
                </div>
              );
            })}
          </div>
          <button className="btn btn-primary">Сохранить ключи</button>
        </form>
      )}

      <div className="card p-4 text-sm">
        <h2 className="mb-2 font-medium">Интеграции</h2>
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
