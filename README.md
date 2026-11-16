# SMM Админка: автопубликация сериалов

Внутренняя админка для YouTube, Instagram и TikTok. Каталог серий берётся из Backblaze B2, недельный план собирается по правилам и утверждается одним действием, worker публикует по расписанию и сообщает о проблемах.

Стек: Next.js 15 (кабинет и REST API), PostgreSQL (данные и очередь задач), отдельный worker (Node + ffprobe/ffmpeg), Docker Compose, Caddy (HTTPS).

## Что умеет пилот

| Раздел | Что есть |
|---|---|
| Каталог | Импорт из публичного реестра B2 (`B2_REGISTRY_URL`) или из приватного бакета по S3 API. Карточки сериал → сезон → эпизод → файлы, версии файлов (sha1/версия B2), ffprobe: длительность, кадр, кодеки. Ручная разметка нераспознанных файлов, отметка «права подтверждены». |
| Аккаунты | YouTube и Instagram через OAuth (state + PKCE, токены шифруются AES-GCM), TikTok вручную или через Upload-Post. Проверка доступа и переподключение. |
| Правила | Сериал, тип материала, язык, аккаунт, формат, видимость, слоты по дням недели или смещение от выпуска серии, шаблон подписи, строгий порядок, маркировка AI/промо/для детей. |
| Неделя | «Собрать неделю» → предпросмотр (время, пояс, @аккаунт, файл, подпись, видимость, маркировка) → правки → «Утвердить неделю». Проверки до утверждения: доступ, файл, длительность/формат, конфликты, квота YouTube, переход часов. Частичное утверждение только с подтверждением. Повторное утверждение тем же ключом идемпотентно. |
| Публикации | Календарь и журнал, попытки, перенос, отмена (с подтверждением площадки), повтор, пакет для TikTok Studio, статусы «Запланировано вручную» и «Опубликовано» с отметкой оператора. |
| Контроль | Очередь исключений на главной, email-дайджест с объединением повторов, `/api/health` для внешнего мониторинга (503, если worker молчит или копятся просроченные задачи). |

Публикация:
- **YouTube**: возобновляемая загрузка за 6 часов до слота, приватно с нативным `publishAt`. Обложка через `thumbnails.set` (нужен подтверждённый канал).
- **Instagram Reels**: контейнер создаётся за 30 минут, `media_publish` ровно в слот. Повторной публикации после неясного результата нет: сначала ищем пост в профиле.
- **TikTok**: по умолчанию ручной пакет (видео, подпись, обложка, время, маркировка). Адаптер Upload-Post включается ключом `UPLOAD_POST_API_KEY`; перед боевым запуском его нужно проверить на тестовом аккаунте.

## Деплой на DigitalOcean

1. Создайте droplet Ubuntu 24.04, 2 ГБ RAM ($12/мес), добавьте свой SSH-ключ.
2. Купите домен и создайте A-запись `admin.<домен>` на IP droplet.
3. На сервере:
   ```bash
   curl -fsSL https://get.docker.com | sh
   git clone https://github.com/mikhadobrin5-del/smm-admin.git && cd smm-admin
   cp .env.example .env
   # заполните DOMAIN, APP_URL, POSTGRES_PASSWORD, SESSION_SECRET, ENCRYPTION_KEY (openssl rand -hex 32), B2_REGISTRY_URL
   docker compose up -d --build
   docker compose exec web npm run user:create -- you@example.com 'длинный-пароль' OWNER
   ```
4. Откройте `https://admin.<домен>`. Caddy сам выпустит сертификат.
5. Каталог: «Каталог → Обновить из B2». Пилотный сериал можно загрузить и без доступа к B2: `docker compose exec web npm run seed:pilot`.

Обновление: `git pull && docker compose up -d --build`. Миграции применяются при старте.

Бэкапы: каждую ночь в `./backups` (14 последних). Проверка восстановления:
```bash
docker compose exec -T db createdb -U smm smm_restore_check
docker compose exec -T db pg_restore -U smm -d smm_restore_check < backups/smm-ГГГГ-ММ-ДД.dump
docker compose exec -T db dropdb -U smm smm_restore_check
```

## Подключение YouTube

1. [Google Cloud Console](https://console.cloud.google.com/) → новый проект → включите **YouTube Data API v3**.
2. OAuth consent screen: External, добавьте scopes `youtube.upload`, `youtube`, `youtube.readonly`. Пока приложение не прошло проверку, добавьте в **Test users** Google-аккаунты владельцев каналов.
3. Credentials → OAuth client ID → Web application. Redirect URI: `https://admin.<домен>/api/oauth/youtube/callback`.
4. Впишите `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET` в `.env`, затем `docker compose up -d`.
5. В админке «Аккаунты → + YouTube канал».

Квота по умолчанию 10 000 единиц в сутки, одна загрузка около 1 600, то есть примерно 6 загрузок в день на весь проект. Лимит задаётся в «Настройках». Увеличение квоты бесплатное, заявка подаётся через форму YouTube API Services.

## Подключение Instagram

1. [developers.facebook.com](https://developers.facebook.com/) → Create app → Business → продукт **Instagram** → «API setup with Instagram login».
2. Redirect URI: `https://admin.<домен>/api/oauth/instagram/callback`. Скопируйте Instagram App ID и Secret в `.env`.
3. Пока приложение в режиме разработки, добавьте нужные Instagram-аккаунты в роли **Instagram testers** и примите приглашение в самом Instagram.
4. Аккаунт должен быть профессиональным (Business или Creator).
5. Для клиентских аккаунтов вне тестировщиков нужны Business Verification и App Review для `instagram_business_content_publishing`.

## Разработка

```bash
npm ci
cp .env.example .env   # DATABASE_URL на локальный Postgres
npx prisma migrate dev
npm run seed:pilot
npm run user:create -- owner@example.com 'pilot-password-123'
npm run dev            # кабинет на :3000
npm run worker         # в отдельном терминале
npm test               # unit + интеграционный тест планировщика (нужна БД)
```

REST API v1 (сессия или cookie): `POST /api/v1/weekly-plans/preview`, `POST /api/v1/weekly-plans/{id}/approve` (заголовок `Idempotency-Key`), `GET /api/v1/publications`, `PATCH /api/v1/publications/{id}` (с `rowVersion`), `POST /api/v1/publications/{id}/retry`.

Часовой пояс: по tzdata 2026e Манитоба (America/Winnipeg) живёт в UTC−5 круглый год, перевода часов нет. Проверка неоднозначного и несуществующего времени работает для правил с другими поясами.
