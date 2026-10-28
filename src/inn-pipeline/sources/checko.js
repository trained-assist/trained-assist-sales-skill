'use strict';

// Checko API — financial data by INN (paid, daily quota)

const DELAY_MS = 400;
let quotaExhausted = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkoFinances(inn, apiKey, cache) {
  if (!apiKey || !inn || quotaExhausted) return null;

  const cacheKey = `finances_${inn}`;
  const cached = cache.get('checko', cacheKey);
  if (cached !== null) return cached;

  await sleep(DELAY_MS);
  try {
    const res = await fetch(`https://api.checko.ru/v2/finances?key=${apiKey}&inn=${inn}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 403) {
      quotaExhausted = true;
      return { _quota_exhausted: true };
    }
    if (!res.ok) { cache.set('checko', cacheKey, null); return null; }

    const data = await res.json();
    const years = Object.keys(data.data || {}).sort().reverse();
    for (const year of years) {
      const rev = data.data[year]['2110'];
      const profit = data.data[year]['2400'];
      if (rev && rev > 0) {
        const result = {
          revenue_mln: Math.round(rev / 1000 * 10) / 10,
          revenue_year: parseInt(year, 10),
          net_profit_mln: profit ? Math.round(profit / 1000 * 10) / 10 : null,
          net_profit_year: profit ? parseInt(year, 10) : null,
        };
        cache.set('checko', cacheKey, result);
        return result;
      }
    }
    cache.set('checko', cacheKey, null);
    return null;
  } catch { return null; }
}

/**
 * Fetch company data from /v2/company endpoint.
 * Returns: employee count (СЧР), tax breakdown (Налоги), director (Руковод), OKVED, region.
 */
async function checkoCompany(inn, apiKey, cache) {
  if (!apiKey || !inn || quotaExhausted) return null;

  const cacheKey = `company_${inn}`;
  const cached = cache.get('checko', cacheKey);
  if (cached !== null) return cached;

  await sleep(DELAY_MS);
  try {
    const res = await fetch(`https://api.checko.ru/v2/company?key=${apiKey}&inn=${inn}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 403) {
      quotaExhausted = true;
      return { _quota_exhausted: true };
    }
    if (!res.ok) { cache.set('checko', cacheKey, null); return null; }

    const data = await res.json();
    const d = data.data || {};
    const result = {};

    // Employee count (СЧР = средняя численность работников)
    if (d['СЧР'] && d['СЧР'] > 0) {
      result.employees = d['СЧР'];
      result.employees_year = d['СЧРГод'] || null;
    }

    // Tax breakdown (Налоги.СведУпл)
    const taxes = d['Налоги'];
    if (taxes && taxes.СведУпл && Array.isArray(taxes.СведУпл)) {
      const taxMap = {};
      for (const t of taxes.СведУпл) {
        const name = (t.Наим || '').toLowerCase();
        const sum = t.Сумма || 0;
        if (name.includes('налог на добавленную стоимость') || name.includesндс) taxMap.vat = sum;
        else if (name.includes('налог на прибыль')) taxMap.profit_tax = sum;
        else if (name.includes('страховые взносы в Pension')) taxMap.pension = sum;
        else if (name.includes('страховые взносы в федеральный фонд обязательного медицинского')) taxMap.medical = sum;
        else if (name.includes('страховые взносы на обязательное социальное страхование')) taxMap.social = sum;
        else if (name.includes('налог на имущество')) taxMap.property_tax = sum;
        else if (name.includes('налог на УСН') || name.includes('усн')) taxMap.usn = sum;
        else if (name.includes('авансовый payment')) taxMap.advances = sum;
        else if (name.includes('земельный')) taxMap.land_tax = sum;
        else if (name.includes('транспортный')) taxMap.transport_tax = sum;
        else if (name.includes('акцизы')) taxMap.excise = sum;
        else if (name.includes('водный')) taxMap.water_tax = sum;
        else if (name.includes('природные')) taxMap.natural_tax = sum;
        else if (name.includes('расходы')) taxMap.spending = sum;
      }
      if (Object.keys(taxMap).length) result.tax_data = taxMap;
    }

    // Director (Руковод)
    if (d['Руковод'] && Array.isArray(d['Руковод']) && d['Руковод'][0]) {
      const dir = d['Руковод'][0];
      result.director_name = dir.ФИО || null;
      result.director_position = dir.НаимДолжн || dir.ВидДолжн || null;
    }

    // OKVED
    if (d['ОКВЭД']) {
      result.okved_code = d['ОКВЭД'].Код || null;
      result.okved_name = d['ОКВЭД'].Наим || null;
    }

    // Region
    if (d['Регион']) {
      result.region_full = d['Регион'].Наим || null;
    }

    cache.set('checko', cacheKey, result);
    return result;
  } catch { return null; }
}

function isQuotaExhausted() { return quotaExhausted; }

module.exports = { checkoFinances, checkoCompany, isQuotaExhausted };