'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Привязка «карточка каталога → сделка Weeek» (sales-skill#19, C4).
//
// Зачем файл, если уже есть hasDeal в API заметок. hasDeal — это флаг в чужом
// хранилище, и он защищает только от ПОСЛЕДУЮЩЕГО нажатия. Не защищает от:
//   · двух одновременных нажатий — оба прочитали hasDeal=false, оба создали;
//   · обрыва связи ПОСЛЕ успешного ответа Weeek — сделка создана, ответа нет,
//     повтор создаёт вторую;
//   · сбоя записи статуса на сайте — сделка создана, каталог её не видит.
//
// Привязка лежит рядом с данными выставки (там же enriched.json), переживает
// перезапуск сессии и принадлежит конкретной выставке, поэтому два разных
// стенда с одной выставки не путаются.
//
// Состояния:
//   creating — записано ДО похода в Weeek. Защищает от второго нажатия, пока
//              первое ещё идёт, и от повтора после потери ответа.
//   created  — Weeek подтвердил, deal_id сохранён. Повторный вызов вернёт ту же
//              сделку, а не создаст вторую.
//   failed   — Weeek отказал явно, сделки нет. Можно повторять.
//   created + site_marked_at пуст — сделка есть, статус на сайте не записан.
//              Доливается flexi_sync_deal_status, создание не повторяется.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// В пределах проекта expoDataDir не различает выставки, поэтому eventKey входит
// в имя файла: иначе две выставки одного проекта делили бы одну привязку.
function bindingFile(dir, eventKey, companyId) {
  const safe = s => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, 'deals', `${safe(eventKey)}__${safe(companyId)}.json`);
}

function readBinding(dir, eventKey, companyId) {
  try {
    const file = bindingFile(dir, eventKey, companyId);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch { return null; }
}

function writeBinding(dir, eventKey, companyId, binding) {
  const file = bindingFile(dir, eventKey, companyId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(binding, null, 2), 'utf8');
  return file;
}

function clearBinding(dir, eventKey, companyId) {
  try { fs.rmSync(bindingFile(dir, eventKey, companyId), { force: true }); } catch { /* ignore */ }
}

function listBindings(dir) {
  const dirPath = path.join(dir, 'deals');
  let names = [];
  try { names = fs.readdirSync(dirPath); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dirPath, name), 'utf8'));
      if (raw && raw.event_key && raw.company_id) out.push(raw);
    } catch { /* ignore */ }
  }
  return out;
}

module.exports = { bindingFile, readBinding, writeBinding, clearBinding, listBindings };