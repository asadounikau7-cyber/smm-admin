# Агент Octo Browser (вариант А: Octo на вашем компьютере)

Агент связывает админку с Octo Browser на вашем компьютере. Он сам обращается к админке по HTTPS каждые 5 секунд, порты открывать не нужно.

## Установка (Windows или macOS)

1. Установите Node.js 22 LTS: https://nodejs.org
2. Скопируйте папку `agent` из репозитория на компьютер.
3. Создайте `agent/config.json` по образцу `config.example.json`:
   - `adminUrl` — адрес админки;
   - `agentToken` — то же значение, что `AGENT_TOKEN` в `.env` на сервере;
   - `octoApiToken` — токен API Octo (только на тарифе Base и выше, для загрузки списка профилей).
4. Запустите Octo Browser, затем в терминале: `node agent/octo-agent.mjs`.
5. В админке на странице «Профили Octo» появится «Агент на компьютере: в сети».

Чтобы агент запускался сам: Windows — ярлык на `node octo-agent.mjs` в папке автозагрузки (`shell:startup`); macOS — `launchd` или пункт входа.

## Что работает на каком тарифе

| | Starter (без API) | Base и выше |
|---|---|---|
| Статус «Octo запущен» в админке | да | да |
| Реестр профилей и привязка аккаунтов | вручную | вручную или «Загрузить профили из Octo» |
| Кнопки «Открыть / Закрыть профиль» | нет, открываете в Octo сами | да, профиль открывается сразу на нужной странице |

Агент использует Local API Octo: `GET /api/username`, `GET /api/profiles/active`, `POST /api/profiles/start`, `POST /api/profiles/stop`. Ответ `start` (поле `ws_endpoint`) нужно проверить при переходе на Base, справочник: https://documenter.getpostman.com/view/1801428/UVC6i6eA
