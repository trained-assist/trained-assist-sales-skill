'use strict';

// Exhibition keys — the ONE source of truth for `event_key` (issue #19).
//
// Extracted from 92-flexi-sales.js so the deal tools can validate a source's
// exhibition without importing a tool module (and so the list is stated once).
// 92-flexi-sales.js keeps its EVENT_NAMES but re-exports from here; anything that
// needs a valid event_key imports this.

const EVENT_NAMES = {
  rosupack2026: 'RosUpack 2026',
  stonefair2026: 'Индустрия камня 2026',
  oborot2026: 'ECOM Expo 2026',
  reindustry2026: 'ReIndustry Expo 2026',
  interautomechanica2026: 'ИнтерАвтоМеханика 2026',
  avtobusexpo2026: 'АвтобусЭкспо 2026',
  ipsa2026: 'IPSA 2026',
  cpmautumn2026: 'CPM Осень 2026',
  textilesalon2026: 'Textile Salon 2026',
  otdykhleisure2026: 'ОТДЫХ Leisure 2026',
};

const EVENT_KEYS = Object.keys(EVENT_NAMES);

function isKnownEvent(eventKey) {
  return Object.hasOwn(EVENT_NAMES, String(eventKey || ''));
}

/** Human name for an event_key, or the key itself when unknown. */
function eventName(eventKey) {
  const k = String(eventKey || '');
  return EVENT_NAMES[k] || k;
}

module.exports = { EVENT_NAMES, EVENT_KEYS, isKnownEvent, eventName };
