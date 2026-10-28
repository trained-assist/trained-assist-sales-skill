Goal: Каталог участников выставки <НАЗВАНИЕ> — от списка участников до целевых компаний на сайте, deal-flow проверен вживую.

## Сбор данных
- [ ] Каталог участников найден и собран (raw.json: name/stand/country/website/categories) — прямой JSON API приоритетнее Playwright-скролла
- [ ] Отфильтрованы РФ-компании (rus.json)
- [ ] ИНН найден через expo-pipeline/pipeline.py enrich (dadata, НЕ inn_enrich_batch по имени — ненадёжно)
- [ ] Финансы получены через pipeline.py (Checko, последний полный год)
- [ ] ЕСХН-гейт применён (pipeline.py делает это автоматически)
- [ ] Классификация целевая/почти-целевая посчитана pipeline.py (без хардкода вручную)

## Checko company data (employees, taxes, director)
- [ ] Скрипт /tmp/fetch-checko-company.js запущен для каждого expo — обогащает targets.json полями: employees, employees_year, tax_data, director_name, director_position, okved_code, region_full
- [ ] В enriched.json есть employees и tax_data для каждой компании (проверить: `jq '.[0] | {emp: .employees, taxes: (.tax_data != null)}'`)
- [ ] Если enriched.json пустой или не массив — сбросить из targets.json (`jq '.' targets.json > enriched.json`)

## Сборка каталога
- [ ] EX-массив собран и инжектирован в HTML-шаблон (bracket-match, НЕ regex; проверить что `];` а не `]];`)
- [ ] В targets.json есть поля employees, tax_data, director_name перед запуском expo_build_catalog (иначе карточки будут без сотрудников/налогов)
- [ ] Ссылка Checko в карточке ведёт на `#taxes` (https://checko.ru/company/{ogrn}#taxes)
- [ ] Диагностические фильтры "С ИНН" / "РФ с ИНН" на сайте есть и считаются из данных
- [ ] Группировка по линиям стенда (не только алфавит) включена

## Деплой и проверка
- [ ] Сайт задеплоен на Cloudflare Pages
- [ ] E2E в браузере: вкладки Целевые/Почти/Производство/Россия показывают РЕАЛЬНОЕ число карточек (не 0 при N выбрано)
- [ ] E2E в браузере: карточка показывает Сотрудники, Всего налогов, Взносы на 1 сотрудника (если данные есть)
- [ ] E2E в браузере: клик по карточке → кнопка "Создать сделку"/deal-link открывает Telegram-бота и создаёт сделку (не просто "страница открылась")
- [ ] Событие подключено в flexi-telegram-deal-bot (EVENT_KEY, ALLOWED_ORIGINS, telegram_companies.json)
- [ ] Итоговые цифры посчитаны и отправлены пользователю (N целевых, N почти, N с ИНН, N с выручкой, N с сотрудниками, ссылка на сайт)