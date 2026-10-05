'use strict';

// DaData API — прямой доступ для разовых запросов.
// Для batch-обогащения используй inn_enrich_batch (70-inn-enrichment.js).

const BASE_SUGGEST  = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party';
const BASE_FIND_ID  = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const BASE_ADDR     = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';
const BASE_CLEAN    = 'https://cleaner.dadata.ru/api/v1/clean/address';

const { readKeys } = require('../inn-keys');

// Same store and precedence as inn_* (user key > platform env).
function readCreds(userId) {
  const k = readKeys(userId);
  return { token: k.dadataToken, secret: k.dadataSecret };
}

async function post(url, creds, body, timeout = 8_000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Token ${creds.token}`,
      'X-Secret':      creds.secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`DaData HTTP ${res.status}`);
  return res.json();
}

function formatParty(s) {
  const d = s.data || {};
  const mgmt = d.management || {};
  return {
    name:        s.value,
    short_name:  d.name?.short_with_opf || null,
    inn:         d.inn  || null,
    ogrn:        d.ogrn || null,
    kpp:         d.kpp  || null,
    okved:       d.okved?.code || null,
    okved_name:  d.okved?.name || null,
    status:      d.state?.status || null,  // ACTIVE / LIQUIDATED / LIQUIDATING
    address:     d.address?.value || null,
    region:      d.address?.data?.region || null,
    director:    mgmt.name || null,
    director_pos: mgmt.post || null,
    type:        d.type || null,  // LEGAL / INDIVIDUAL
  };
}

module.exports = { tools: {

  dadata_address: {
    description: `Suggest or clean a Russian address via DaData.
mode=suggest — autocomplete (returns up to N options).
mode=clean   — normalize and parse a single address into parts.`,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Address string to look up or clean' },
        mode:    { type: 'string', enum: ['suggest', 'clean'], default: 'suggest' },
        count:   { type: 'number', description: 'Max suggestions (suggest mode only)', default: 3 },
      },
    },
    handler: async ({ address, mode = 'suggest', count = 3 }, ctx) => {
      const creds = readCreds(ctx?.userId);
      if (!creds.token) return { error: 'DaData token not configured. Run: inn_set_dadata_token' };

      if (mode === 'clean') {
        let data;
        try {
          const res = await fetch(BASE_CLEAN, {
            method: 'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Token ${creds.token}`,
              'X-Secret':      creds.secret,
            },
            body: JSON.stringify([address]),
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) return { error: `DaData HTTP ${res.status}` };
          data = await res.json();
        } catch (e) { return { error: e.message }; }
        return { mode: 'clean', result: data[0] || null };
      }

      let data;
      try { data = await post(BASE_ADDR, creds, { query: address, count }); }
      catch (e) { return { error: e.message }; }

      return {
        mode: 'suggest',
        suggestions: (data.suggestions || []).map(s => ({
          value: s.value,
          postal_code:  s.data?.postal_code || null,
          region:       s.data?.region      || null,
          city:         s.data?.city        || null,
          street:       s.data?.street      || null,
          house:        s.data?.house       || null,
        })),
      };
    },
  },

}};
