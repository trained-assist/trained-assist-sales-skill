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
const { randomBytes } = require('crypto');

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
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(binding, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dirFd = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch {}
  }
  return file;
}

// The file itself is the cross-process claim. O_EXCL makes two simultaneous
// handlers choose exactly one creator before either dispatches to Weeek.
function claimBinding(dir, eventKey, companyId, binding) {
  const file = bindingFile(dir, eventKey, companyId);
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(binding, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    const dirFd = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
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

module.exports = { bindingFile, readBinding, writeBinding, claimBinding, clearBinding, listBindings };
