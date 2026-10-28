Goal: Каталог участников выставки <НАЗВАНИЕ> — от списка участников до целевых компаний на сайте, deal-flow проверен вживую.

## Сбор данных
- [ ] Каталог участников найден и собран (raw.json)
- [ ] Отфильтрованы РФ-компании (rus.json)
- [ ] ИНН найден через expo-pipeline/pipeline.py enrich
- [ ] Финансы получены через pipeline.py (Checko)
- [ ] Классификация (t/nt) посчитана pipeline.py

## Checko company data (employees, taxes, director)
- [ ] Скрипт /tmp/fetch-checko-company.js запущен для expo (employees, tax_data, director и др.)
- [ ] В targets.json (промежуточный) перенесены данные из enriched.json для сборки

## Сборка каталога
- [ ] EX-массив собран и инжектирован в HTML-шаблон
- [ ] Ссылка Checko ведет на `#taxes`
- [ ] Группировка по линиям стенда включена

## CI/CD и Проверка
- [ ] Сайт задеплоен на Cloudflare Pages
- [ ] E2E тест: `npx wrangler d1 execute --command "SELECT * FROM ..."` или проверка через API, что карточки (Сотрудники/Налоги/Директор) прогрузились
- [ ] **Smoke Test (Deal Creation):**
    - [ ] Бот сконфигурирован (EVENT_KEY, telegram_companies.json актуален)
    - [ ] Создана **тестовая сделка** через `/start <payload>` (проверка, что бот принимает ID и создает сделку в Weeek)
    - [ ] Проверено, что сделка появилась в Weeek в нужной воронке (проверка через `weeek_list_deals`)
- [ ] Финальный отчет отправлен пользователю (N целевых, N с сотрудниками, ссылка на сайт, статус CI)