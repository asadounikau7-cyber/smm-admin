import { db } from "@/lib/db";
import { env, b2Configured, fileEnv } from "@/lib/env";
import { storedIntegrationKeys } from "@/lib/integrationKeys";
import { requireUser } from "@/lib/auth";
import { Flash, PageHeader } from "@/components/ui";
import { getYtTestSettings } from "@/lib/seriesTest";
import { saveConveyorSettingsAction, saveYtTestSettingsAction } from "@/app/testActions";
import { getConveyorSettings } from "@/lib/conveyor";
import { changeMyPasswordAction, saveIntegrationKeysAction, createUserAction, deleteUserAction, saveSettingsAction } from "@/app/actions";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const [users, settings] = await Promise.all([db.user.findMany({ orderBy: { createdAt: "asc" } }), db.setting.findMany()]);
  const get = (k: string) => settings.find((x) => x.key === k)?.value;
  const e = env();
  const stored = await storedIntegrationKeys();
  const ytTest = await getYtTestSettings();
  const conv = await getConveyorSettings();
  const ytAccounts = await db.socialAccount.findMany({ where: { platform: "YOUTUBE" }, include: { octoProfile: { select: { title: true } } }, orderBy: { handle: "asc" } });
  const ytLabel = (a: (typeof ytAccounts)[number]) => `@${a.handle}${a.octoProfile ? ` · Octo «${a.octoProfile.title}»` : ""}`;
  const fe = fileEnv();
  const KEYS = [
    { k: "GOOGLE_CLIENT_ID", label: "Google Client ID", group: "YouTube" },
    { k: "GOOGLE_CLIENT_SECRET", label: "Google Client Secret", group: "YouTube" },
    { k: "INSTAGRAM_APP_ID", label: "Instagram App ID", group: "Instagram" },
    { k: "INSTAGRAM_APP_SECRET", label: "Instagram App Secret", group: "Instagram" },
    { k: "UPLOAD_POST_API_KEY", label: "Upload-Post API key", group: "TikTok" },
    { k: "B2_KEY_ID", label: "Backblaze keyID (ключ только на чтение)", group: "B2" },
    { k: "B2_APP_KEY", label: "Backblaze applicationKey", group: "B2" },
    { k: "GMAIL_APP_PASSWORD", label: "Пароль приложения Gmail (16 букв) для писем об авариях", group: "Почта" },
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

      <form action={saveConveyorSettingsAction} className="card space-y-3 p-4 text-sm">
        <h2 className="font-medium">YouTube-конвейер</h2>
        <p className="text-xs muted">
          Тестовые каналы (роль «Тестовый» и гео в «Аккаунтах») каждый день сами проверяют сериалы в своих слотах по местному времени гео (US — Нью-Йорк, UK — Лондон).
          Прошедший сериал встаёт в очередь боевого канала своего гео, и его первые серии выходят по слотам боевого канала. Подробности на странице «YouTube-конвейер».
        </p>
        <label className="flex items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={conv.enabled} /> Конвейер включён</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="autoPick" defaultChecked={conv.autoPick} /> Если очередь на тест пуста, брать следующие непроверенные сериалы из каталога</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="channelVersions" defaultChecked={conv.channelVersions} /> Уникализация: боевые каналы с шаблоном публикуют свою версию серии (рендер агентом или сервером; пока версия не готова, уходит оригинал)</label>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">Слоты тестовых каналов (сколько слотов, столько сериалов в день на канал)</label>
            <input name="testSlots" defaultValue={conv.testSlots.join(", ")} className="input" />
          </div>
          <div>
            <label className="label">Случайный сдвиг теста, ± мин</label>
            <input name="jitterMin" type="number" min={0} max={30} defaultValue={conv.jitterMin} className="input" />
          </div>
          <div>
            <label className="label">Слоты боевых каналов</label>
            <input name="mainSlots" defaultValue={conv.mainSlots.join(", ")} className="input" />
          </div>
          <div>
            <label className="label">Слоты TikTok и Instagram (пусто = не публиковать)</label>
            <input name="socialSlots" defaultValue={conv.socialSlots.join(", ")} className="input" />
          </div>
          <div>
            <label className="label">Сколько первых серий выкладывать на боевой</label>
            <input name="mainEpisodes" type="number" min={1} defaultValue={conv.mainEpisodes} className="input" />
          </div>
          <div>
            <label className="label">Пауза тестов, если боевые расписаны дальше чем на, дней</label>
            <input name="backlogDays" type="number" min={1} defaultValue={conv.backlogDays} className="input" />
          </div>
        </div>
        <p className="text-xs muted">Время слотов указывается в пределах 09:00–23:00 по местному времени канала. Между загрузками на одном тестовом канале не меньше 2 часов. Второй тестовый канал того же гео сдвигается на 50 мин, чтобы каналы не грузили одновременно.</p>
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
                  {/* Text, masked by CSS: browsers don't put saved passwords into text fields. */}
                  <input
                    name={k}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    className="input"
                    style={k.endsWith("_ID") ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
                    placeholder={fromDb || fromFile ? "оставьте пустым, чтобы не менять" : ""}
                  />
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
          <li>Email-уведомления: {check(Boolean((e.SMTP_URL || e.GMAIL_APP_PASSWORD) && e.NOTIFY_EMAILS))} {e.NOTIFY_EMAILS && <span className="muted">→ {e.NOTIFY_EMAILS}</span>}</li>
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
