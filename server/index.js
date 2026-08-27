// Flight Tracker — TREK reservation-detail widget.
// Combines AeroDataBox (schedule/status, needs a RapidAPI key) with
// adsb.fi opendata (live airborne position, free/no key). Handles multi-leg
// flights (each leg has its own airline + flight number). Runs in an isolated
// child process; all host access is via `ctx`.
const { definePlugin } = require('trek-plugin-sdk');

// Full airline dataset (OpenFlights-derived), bundled under server/data.
let DATA = { nameToIata: {}, iataIcao: {} };
try { DATA = require('./data/airlines.json'); } catch (_e) { /* optional */ }

const ADSB_HOST = 'https://opendata.adsb.fi/api';
const AERO_HOST = 'https://aerodatabox.p.rapidapi.com';

const CACHE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 7000;
const MAX_LEGS = 6;

// The free AeroDataBox tier is ~600 requests/month. We stop a little short so a
// deliberate act — an admin pressing "Test AeroDataBox key" — still has room, and
// so the month never ends with every lookup failing. Past the ceiling the plugin
// keeps working on adsb.fi alone rather than going dark.
const AERO_MONTHLY_BUDGET = 550;
// The background job may spend at most this share of the month. Without a separate
// ceiling a few long-haul flights would drain the whole budget on their own and
// every user's widget would then show "monthly quota reached" — the job must never
// be able to starve the interactive path that a person is actually waiting on.
const AERO_JOB_SHARE = 0.6;
// How long a leg must rest between background refreshes. Tight only where the data
// really moves; the native surfaces (warnings, markers, table, badge) treat a
// payload as fresh for 30 minutes anyway, so refreshing faster than that buys
// nothing and costs the shared key.
const JOB_INTERVAL_NEAR_MS = 15 * 60 * 1000;   // within 1h of departure, or airborne
const JOB_INTERVAL_FAR_MS = 45 * 60 * 1000;    // the rest of the window
// A rejected key is remembered, but NOT for ever: a 403 usually means an unsubscribed
// or lapsed RapidAPI plan, which an admin fixes upstream WITHOUT the key string ever
// changing. Expire the flag so the instance heals itself instead of needing someone
// to find the quota table.
const KEY_INVALID_TTL_MS = 6 * 3600 * 1000;
// The settings-page "Test" button runs USER-bound for every user, not just admins,
// and spends a real request. Bound both how often it can spend and how many times a
// day, and reuse a recent answer in between.
const TEST_KEY_CACHE_MS = 5 * 60 * 1000;
const TEST_KEY_PER_DAY = 20;
// POST /set re-queries with a new number, so it also spends. /refresh is already
// throttled; without this, /set was the unthrottled way to the same requests.
const SET_COOLDOWN_MS = 15 * 1000;
// adsb.fi opendata is free and asks for <= 1 request/second. The old code spaced
// LEGS but issued up to four calls inside one leg in a few milliseconds.
const ADSB_MIN_GAP_MS = 1100;
// A forced refresh re-queries every leg with force=true, bypassing the TTL. Without
// a floor, one user holding the refresh button burns the instance-wide monthly quota.
const FORCE_COOLDOWN_MS = 60 * 1000;
// Defaults for the two scope:'user' settings. Userless contexts (the cron job,
// event handlers) get `undefined` from ctx.settings.get and must fall back to these.
const DEFAULT_DELAY_THRESHOLD_MIN = 15;
const DELAY_THRESHOLD_MIN_BOUNDS = [1, 240];

// Curated overrides — win over the dataset (fixes cargo/subsidiary IATA clashes
// like LH -> DLH, not GEC). Names lowercased.
const CURATED_IATA = {
  'austrian': 'OS', 'austrian airlines': 'OS', 'lufthansa': 'LH', 'swiss': 'LX',
  'eurowings': 'EW', 'brussels airlines': 'SN', 'air france': 'AF', 'klm': 'KL',
  'british airways': 'BA', 'iberia': 'IB', 'vueling': 'VY', 'ryanair': 'FR',
  'easyjet': 'U2', 'wizz air': 'W6', 'turkish airlines': 'TK', 'emirates': 'EK',
  'qatar airways': 'QR', 'etihad': 'EY', 'etihad airways': 'EY', 'united': 'UA',
  'united airlines': 'UA', 'american airlines': 'AA', 'delta': 'DL', 'delta air lines': 'DL',
  'ita airways': 'AZ', 'alitalia': 'AZ', 'condor': 'DE', 'sas': 'SK', 'finnair': 'AY',
  'norwegian': 'DY', 'tap air portugal': 'TP', 'aer lingus': 'EI', 'aegean': 'A3',
  'lot polish airlines': 'LO', 'transavia': 'HV', 'edelweiss': 'WK', 'sunexpress': 'XQ',
};
const CURATED_ICAO = {
  OS: 'AUA', LH: 'DLH', LX: 'SWR', EW: 'EWG', SN: 'BEL', AF: 'AFR', KL: 'KLM', BA: 'BAW',
  IB: 'IBE', VY: 'VLG', FR: 'RYR', U2: 'EZY', W6: 'WZZ', TK: 'THY', EK: 'UAE', QR: 'QTR',
  EY: 'ETD', UA: 'UAL', AA: 'AAL', DL: 'DAL', AZ: 'ITY', DE: 'CFG', SK: 'SAS', AY: 'FIN',
  DY: 'NAX', TP: 'TAP', EI: 'EIN', A3: 'AEE', LO: 'LOT', HV: 'TRA', WK: 'EDW', XQ: 'SXS',
};

// --- small helpers ----------------------------------------------------------

// Swallow-and-fall-back. RESERVED for genuinely optional host namespaces (ctx.meta
// and friends can be undefined on a host that predates them, and the throw is
// SYNCHRONOUS at property access — which is why every caller must pass a thunk).
// For anything whose failure is meaningful, use tryLog() below instead: a silent
// catch on a notify or a cache write is how a plugin ends up "doing nothing" with a
// clean log in Admin -> Plugins.
async function attempt(fn, fallback) {
  try { return await fn(); } catch (_e) { return fallback; }
}

// Same shape, but the failure reaches the plugin's error log.
async function tryLog(ctx, label, fn, fallback) {
  try { return await fn(); } catch (e) {
    try { ctx.log.warn(label + ' failed', { error: String((e && e.message) || e) }); } catch (_e) { /* logging must never throw */ }
    return fallback;
  }
}

async function fetchJson(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal }, options));
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_e) { data = null; }
    return {
      ok: res.ok, status: res.status, data,
      // Surfaced so the caller can tell a rejected key (401/403 — sticky, stop
      // calling) from a transient failure, and can read RapidAPI's quota header.
      headers: res.headers,
      error: res.ok ? null : (data && (data.message || data.error)) || ('HTTP ' + res.status),
    };
  } catch (e) {
    return { ok: false, status: 0, data: null, headers: null, error: e.name === 'AbortError' ? 'timeout' : String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// adsb.fi asks for <= 1 req/s. Serialise every call to it through one module-level
// gate: trackLeg can otherwise fire three call-sign attempts plus a registration
// lookup inside a few milliseconds, which is a burst against a free tier.
let adsbGate = Promise.resolve();
let adsbLastAt = 0;
function adsbFetch(path) {
  const run = adsbGate.then(async () => {
    // Wait only the REMAINDER of the gap since the previous call, never a flat
    // sleep afterwards. A trailing sleep would charge the last request in a burst
    // for a gap nobody is waiting on — and a route handler has a hard 30 s budget.
    const wait = ADSB_MIN_GAP_MS - (Date.now() - adsbLastAt);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    adsbLastAt = Date.now();
    return fetchJson(ADSB_HOST + path, { headers: { accept: 'application/json' } });
  });
  // The gate must advance even when a call rejects, or one failure stalls every
  // later adsb.fi request for the lifetime of the process.
  adsbGate = run.then(() => undefined, () => undefined);
  return run;
}

function normNumber(raw) {
  if (!raw) return '';
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function withSpaceNum(n) {
  const m = String(n || '').match(/^([A-Z]{2,3})(\d.*)$/);
  return m ? m[1] + ' ' + m[2] : String(n || '');
}

// Known-code sets, built once from the bundled dataset + curated overrides. They
// let splitFlight() tell a real airline prefix from a coincidental letter run.
let CODES = null;
function codes() {
  if (CODES) return CODES;
  const iata = Object.create(null), icao = Object.create(null), icaoToIata = Object.create(null);
  // A real IATA airline designator is two chars with at least one LETTER (LL, LD
  // or DL). Admitting an all-digit "code" would make splitFlight read the first
  // two digits of a bare flight number as an airline ("1234" -> "12" + "34").
  const addIata = (c) => { if (/^[A-Z0-9]{2}$/.test(c || '') && /[A-Z]/.test(c)) iata[c] = 1; };
  Object.keys(DATA.iataIcao || {}).forEach(addIata);
  Object.keys(DATA.nameToIata || {}).forEach((k) => addIata(DATA.nameToIata[k]));
  Object.keys(DATA.coreToIata || {}).forEach((k) => addIata(DATA.coreToIata[k]));
  Object.keys(CURATED_IATA).forEach((k) => addIata(CURATED_IATA[k]));
  const pair = (i, c) => { if (/^[A-Z]{3}$/.test(c || '')) { icao[c] = 1; if (!icaoToIata[c]) icaoToIata[c] = i; } };
  Object.keys(DATA.iataIcao || {}).forEach((i) => pair(i, DATA.iataIcao[i]));
  Object.keys(CURATED_ICAO).forEach((i) => pair(i, CURATED_ICAO[i]));
  CODES = { iata, icao, icaoToIata };
  return CODES;
}

// Name normalisation mirrors scripts/build-airlines.js so the lookup keys match.
const CORP_WORDS = { inc: 1, ltd: 1, llc: 1, plc: 1, co: 1, corp: 1, corporation: 1, company: 1,
  group: 1, holdings: 1, holding: 1, limited: 1, sa: 1, ag: 1, gmbh: 1, srl: 1, spa: 1, as: 1, ab: 1,
  oy: 1, nv: 1, bv: 1, pty: 1, pvt: 1, private: 1, jsc: 1, ojsc: 1, cjsc: 1, llp: 1, sas: 1, sarl: 1 };
const GENERIC_WORDS = { airlines: 1, airline: 1, airways: 1, airway: 1, air: 1, lines: 1, line: 1,
  aviation: 1, aviacion: 1, aerolineas: 1, aerolinea: 1, airliner: 1, aero: 1, linhas: 1, aereas: 1,
  luchtvaartmaatschappij: 1, international: 1, intl: 1, transport: 1, transports: 1, travel: 1 };

function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function coreName(s) {
  return normName(s).split(' ').filter((w) => w && !GENERIC_WORDS[w] && !CORP_WORDS[w]).join(' ');
}

// Split a flight designator into airline prefix + number. IATA airline codes are
// two ALPHANUMERIC characters (F9 Frontier, U2 easyJet, 6E IndiGo) — 452 of the
// ~1100 codes we know contain a digit — so a letters-only prefix regex mis-parses
// them ("F91234" -> "F" + "91234", five digits, no match at all). Candidate splits
// are therefore scored, with a prefix that is a KNOWN airline code winning.
function splitFlight(raw) {
  const s = normNumber(raw);
  if (!s) return null;
  const K = codes();
  let best = null;
  for (let n = 0; n <= 3 && n < s.length; n++) {
    const prefix = s.slice(0, n);
    const m = s.slice(n).match(/^(\d{1,4})([A-Z]?)$/);
    if (!m) continue;
    let score;
    if (n === 0) score = 5;                                  // bare number; airline comes from the booking
    else if (n === 2 && K.iata[prefix]) score = 100;         // known IATA — the common, unambiguous case
    else if (n === 3 && K.icao[prefix]) score = 90;          // known ICAO (e.g. DLH400)
    else if (n === 2 && /^(?:[A-Z][A-Z0-9]|[0-9][A-Z])$/.test(prefix)) score = 50; // IATA-shaped, unknown
    else if (n === 3 && /^[A-Z]{3}$/.test(prefix)) score = 40;
    else if (n === 1 && /^[A-Z]$/.test(prefix)) score = 10;
    else continue;
    if (!best || score > best.score || (score === best.score && n > best.prefix.length)) {
      best = { prefix, digits: m[1], suffix: m[2] || '', score };
    }
  }
  return best;
}

function airlineToIata(name, code) {
  if (code) { const c = String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''); if (/^[A-Z0-9]{2}$/.test(c)) return c; }
  if (!name) return '';
  // Exact, then spelling variants, then the aggressively stripped "core" name —
  // so "Delta Airlines", "Delta Air Lines" and "Delta Air Lines, Inc." all hit DL.
  const n = normName(name);
  if (!n) return '';
  const tries = [n, n.replace(/\bair lines\b/g, 'airlines'), n.replace(/\bairlines\b/g, 'air lines')];
  for (const t of tries) {
    if (CURATED_IATA[t]) return CURATED_IATA[t];
    if (DATA.nameToIata[t]) return DATA.nameToIata[t];
  }
  const c = coreName(n);
  if (c) {
    if (CURATED_IATA[c]) return CURATED_IATA[c];
    if (DATA.coreToIata && DATA.coreToIata[c]) return DATA.coreToIata[c];
    if (DATA.nameToIata[c]) return DATA.nameToIata[c];
  }
  return '';
}

function iataToIcao(iata, code) {
  if (code) { const c = String(code).toUpperCase().replace(/[^A-Z]/g, ''); if (/^[A-Z]{3}$/.test(c)) return c; }
  if (iata) { if (CURATED_ICAO[iata]) return CURATED_ICAO[iata]; if (DATA.iataIcao[iata]) return DATA.iataIcao[iata]; }
  return '';
}

// A 3-letter ICAO prefix typed into the flight-number box ("DLH400") must become
// the IATA form before querying AeroDataBox, which keys on IATA numbers.
function icaoToIata(icao) {
  const K = codes();
  return (icao && K.icaoToIata[icao]) || '';
}

function parseMeta(r) {
  if (!r) return {};
  let m = r.metadata != null ? r.metadata : r.meta;
  if (typeof m === 'string') { try { m = JSON.parse(m || '{}'); } catch (_e) { m = {}; } }
  return (m && typeof m === 'object') ? m : {};
}

// Parse a reservation datetime ('YYYY-MM-DDTHH:MM' or with a space) into an
// epoch-ms estimate and the local date string used for the AeroDataBox query.
// A reservation time is a NAIVE local time at the departure airport — TREK stores
// no offset. Parsing it without one made Date.parse use the SERVER's timezone, so
// every derived window silently shifted by the host's offset (and moved when the
// host moved). We parse as UTC instead: still not the airport's true instant, but
// deterministic and host-independent, with a known bound on the error (±14h, the
// range of real UTC offsets). Callers must therefore treat this as an ESTIMATE and
// apply TZ_SLACK; the authoritative instants are the *Utc fields AeroDataBox
// returns, which replace these as soon as a status lookup succeeds.
function parseDateTime(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const iso = m[4] ? (m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00Z')
    : (m[1] + '-' + m[2] + '-' + m[3] + 'T12:00:00Z');
  const ms = Date.parse(iso);
  return { ms: isNaN(ms) ? null : ms, date: m[1] + '-' + m[2] + '-' + m[3], estimated: true };
}

// Ordered endpoints (from -> stops -> to), by `sequence`.
function orderedEndpoints(r) {
  if (!Array.isArray(r.endpoints)) return [];
  return r.endpoints.slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
}

// Mirror of TREK's getFlightLegs: metadata.legs is the source of truth for
// multi-leg; otherwise a single leg from the ordered endpoints + flat metadata.
function getFlightLegs(r) {
  const meta = parseMeta(r);
  if (Array.isArray(meta.legs) && meta.legs.length) {
    return meta.legs.slice(0, MAX_LEGS).map((l) => ({
      from: l.from || null, to: l.to || null,
      airline: l.airline || null, airlineCode: l.airline_code || null,
      flight: l.flight_number || l.flightNumber || null,
      depTime: l.dep_time || null, arrTime: l.arr_time || null,
      depDayId: l.dep_day_id != null ? l.dep_day_id : null,
      arrDayId: l.arr_day_id != null ? l.arr_day_id : null,
      seat: l.seat || null,
    }));
  }
  const eps = orderedEndpoints(r);
  const first = eps[0], last = eps[eps.length - 1];
  const from = (first && first.code) || meta.departure_airport || null;
  const to = (last && last.code) || meta.arrival_airport || null;
  if (!from && !to && !meta.flight_number) return [];
  return [{
    from, to,
    airline: meta.airline || null, airlineCode: meta.airline_code || null,
    flight: meta.flight_number || meta.flightNumber || null,
    depTime: (first && first.local_time) || null,
    arrTime: (last && last.local_time) || null,
    depDayId: r.day_id != null ? r.day_id : null,
    arrDayId: r.end_day_id != null ? r.end_day_id : (r.day_id != null ? r.day_id : null),
    seat: meta.seat || null,
    localDepDate: (first && first.local_date) || null,
  }];
}

// Resolve a raw leg into queryable identifiers.
function resolveLeg(leg) {
  let number = '', callsign = '';
  const sf = leg.flight ? splitFlight(leg.flight) : null;
  if (sf) {
    const fromBooking = airlineToIata(leg.airline, leg.airlineCode);
    // Precedence: an ICAO prefix maps back to IATA; a *known* IATA prefix in the
    // typed number is authoritative; otherwise the booking's airline field wins,
    // with the typed prefix as the last resort. This makes "F9 1234", bare "1234"
    // + "Frontier Airlines", and "DLH400" all resolve to the same flight.
    let iata;
    if (sf.prefix.length === 3) iata = icaoToIata(sf.prefix) || fromBooking || '';
    else if (sf.prefix && sf.score >= 100) iata = sf.prefix;
    else iata = fromBooking || sf.prefix;
    if (iata) number = iata + sf.digits + sf.suffix;
    const icao = (sf.prefix.length === 3 && codes().icao[sf.prefix])
      ? sf.prefix : iataToIcao(iata, leg.airlineCode);
    if (icao) callsign = icao + sf.digits + sf.suffix;
  }
  return {
    number, callsign, airline: leg.airline, from: leg.from, to: leg.to,
    depTime: leg.depTime, arrTime: leg.arrTime, rawFlight: leg.flight,
    depDayId: leg.depDayId != null ? leg.depDayId : null,
    arrDayId: leg.arrDayId != null ? leg.arrDayId : null,
    seat: leg.seat || null, localDepDate: leg.localDepDate || null,
  };
}

// --- quota governor ----------------------------------------------------------
// Everything that meters the AeroDataBox key. The key is INSTANCE-WIDE, so this is
// a shared resource: one user leaning on the refresh button used to be able to
// exhaust the month for everyone, with no counter anywhere and no way to see it.
// All state lives in the plugin's own `quota` table so it survives a restart.

function monthKey() { const d = new Date(); return 'ada:' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

async function quotaGet(ctx, k) {
  const rows = await attempt(() => ctx.db.query('SELECT n FROM quota WHERE k = ?', k), []);
  return (rows && rows[0] && Number(rows[0].n)) || 0;
}
async function quotaSet(ctx, k, n) {
  await tryLog(ctx, 'quota.set', () => ctx.db.exec('INSERT OR REPLACE INTO quota (k, n, updated_at) VALUES (?, ?, ?)', k, Number(n) || 0, Date.now()));
}
async function quotaBump(ctx, k, by) {
  await tryLog(ctx, 'quota.bump', () => ctx.db.exec(
    'INSERT INTO quota (k, n, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = n + ?, updated_at = ?',
    k, Number(by) || 1, Date.now(), Number(by) || 1, Date.now()));
}

// A key RapidAPI answers with 401/403 is not a transient failure — every further
// call spends a request to be told the same thing. So remember it, but remember it
// with a TIMESTAMP, not a boolean: a 403 is most often an unsubscribed or lapsed
// plan, which an admin fixes at RapidAPI without the key string ever changing. A
// boolean flag keyed to the key's fingerprint could then never clear, and the
// instance stayed dark until someone edited the plugin's database. The window is
// long enough that a genuinely dead key is not retried on every render, and short
// enough that an upstream fix heals on its own.
async function keyInvalid(ctx) {
  const at = await quotaGet(ctx, 'ada:invalid');
  return at > 0 && (Date.now() - at) < KEY_INVALID_TTL_MS;
}

// True when we may still spend an AeroDataBox request this month.
async function aeroAllowed(ctx) {
  if (await keyInvalid(ctx)) return false;
  return (await quotaGet(ctx, monthKey())) < AERO_MONTHLY_BUDGET;
}

// --- per-user settings -------------------------------------------------------
// scope:'user' values are NOT in ctx.config. ctx.settings.get returns the acting
// user's own value — and `undefined` both when unset and in ANY userless context
// (the cron job, event handlers), so every read needs a constant fallback.

async function userDelayThreshold(ctx) {
  const raw = await attempt(() => ctx.settings.get('delay_threshold_min'), undefined);
  const n = Math.round(Number(raw));
  if (!isFinite(n)) return DEFAULT_DELAY_THRESHOLD_MIN;
  return Math.min(DELAY_THRESHOLD_MIN_BOUNDS[1], Math.max(DELAY_THRESHOLD_MIN_BOUNDS[0], n));
}
async function userNotifyEnabled(ctx) {
  const raw = await attempt(() => ctx.settings.get('notify_enabled'), undefined);
  return String(raw == null ? 'on' : raw).toLowerCase() !== 'off';   // default on
}

// --- great-circle geometry (for the trip-map route overlay) ------------------
// A flight path is a great circle, not a straight line on a Mercator map: drawing
// FRA->NRT as a straight segment puts it over Iran instead of Siberia. Spherical
// interpolation, the same maths the widget's own minimap uses.

function gcPoints(a, b, n) {
  const R = Math.PI / 180;
  const la1 = a.lat * R, lo1 = a.lon * R, la2 = b.lat * R, lo2 = b.lon * R;
  const d = 2 * Math.asin(Math.sqrt(
    Math.pow(Math.sin((la2 - la1) / 2), 2) +
    Math.cos(la1) * Math.cos(la2) * Math.pow(Math.sin((lo2 - lo1) / 2), 2)));
  const out = [];
  if (!isFinite(d) || d === 0) return [[a.lat, a.lon], [b.lat, b.lon]];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    out.push([Math.atan2(z, Math.sqrt(x * x + y * y)) / R, Math.atan2(y, x) / R]);
  }
  return out;
}

// Wrap a longitude difference into (-180, 180]. Needed anywhere two longitudes are
// compared: raw subtraction says LAX (-118) and HND (140) are 258 degrees apart.
function lonDelta(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// atan2 normalises every longitude into (-180, 180], so a great circle crossing the
// antimeridian comes back as ... 179.6, -178.0 ... — and a renderer joins those two
// vertices with a straight segment running the LONG way, right across the map. That
// is the same class of artefact the great-circle maths exists to remove, and it hits
// exactly the trans-Pacific routes it matters most for.
//
// Split into separate polylines at the crossing rather than emitting longitudes
// beyond ±180: the host range-checks coordinates, so the out-of-range trick that
// some map libraries accept is not available here. Each piece is cut at the
// meridian itself, so the two halves meet edge to edge instead of leaving a gap.
function splitAntimeridian(points) {
  const parts = [];
  let cur = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1], p = points[i];
    if (Math.abs(p[1] - prev[1]) > 180) {
      // Latitude where the path meets the meridian, by linear interpolation across
      // the (short) wrapped span — at 48 vertices a segment is a few degrees, so
      // this is well inside the width of the drawn line.
      // The TRUE direction of travel, not the sign of the raw jump: going east from
      // 179.2 to -178.4 looks like a huge negative step but is a small positive one.
      const d = lonDelta(p[1], prev[1]);
      const eastward = d > 0;                   // crossing +180 into -180
      const edgePrev = eastward ? 180 : -180;
      const span = Math.abs(d) || 1;
      const f = Math.abs(lonDelta(edgePrev, prev[1])) / span;
      const lat = prev[0] + (p[0] - prev[0]) * f;
      cur.push([lat, edgePrev]);
      parts.push(cur);
      cur = [[lat, eastward ? -180 : 180], p];
    } else {
      cur.push(p);
    }
  }
  parts.push(cur);
  return parts.filter((seg) => seg.length >= 2);   // a polyline needs two points
}

// --- external data sources ---------------------------------------------------

async function fetchAero(ctx, number, key, date) {
  if (!key || !number) return { data: null, error: null };
  // Metered: the key is instance-wide, so this counter is the only thing standing
  // between one busy trip and everyone else's month.
  if (!(await aeroAllowed(ctx))) {
    return { data: null, error: (await keyInvalid(ctx)) ? 'key rejected' : 'monthly quota reached' };
  }
  // With a booking date we query the exact day (accurate for future flights and
  // avoids matching a different day's operation of the same number).
  const datePath = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? '/' + date : '';
  const url = AERO_HOST + '/flights/number/' + encodeURIComponent(number) + datePath +
    '?withAircraftImage=false&withLocation=true&dateLocalRole=Both';
  await quotaBump(ctx, monthKey(), 1);
  const r = await fetchJson(url, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'aerodatabox.p.rapidapi.com' },
  });
  // RapidAPI reports what is actually left; prefer it over our own counter, which
  // cannot know about calls made before this version shipped or from elsewhere.
  const remaining = r.headers && r.headers.get && r.headers.get('x-ratelimit-requests-remaining');
  if (remaining != null && remaining !== '' && isFinite(Number(remaining))) {
    await quotaSet(ctx, 'ada:remaining', Number(remaining));
  }
  if (r.status === 401 || r.status === 403) {
    // Remembered for KEY_INVALID_TTL_MS, and cleared outright when the key changes.
    await quotaSet(ctx, 'ada:invalid', Date.now());
    ctx.log.warn('AeroDataBox rejected the key', { status: r.status });
    return { data: null, error: 'key rejected (HTTP ' + r.status + ')' };
  }
  if (!r.ok) return { data: null, error: r.error || 'aerodatabox error' };
  const list = Array.isArray(r.data) ? r.data
    : (r.data && Array.isArray(r.data.flights) ? r.data.flights
      : (r.data && r.data.departure ? [r.data] : []));
  if (!list.length) return { data: null, error: null };
  // dateLocalRole=Both also returns the PREVIOUS day's operation when it arrives on
  // the pinned date, so a red-eye (dep 23:40, arr 07:10+1) gets two candidates. The
  // closest-to-now tie-break below reliably picks the earlier — i.e. wrong — one for
  // an upcoming flight, showing yesterday's gate, status and delay. Keep only
  // candidates that actually DEPART on the pinned date; fall back to the unfiltered
  // list if that leaves nothing, so a schedule quirk can't blank the widget.
  let pool = list;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    const sameDay = list.filter((f) => {
      const t = f && f.departure && f.departure.scheduledTime;
      const local = t && (t.local || t.utc);
      return typeof local === 'string' && local.slice(0, 10) === date;
    });
    if (sameDay.length) pool = sameDay;
  }
  const now = Date.now();
  pool.sort((a, b) => Math.abs(depTime(a) - now) - Math.abs(depTime(b) - now));
  return { data: normaliseAero(pool[0]), error: null };
}

function depTime(f) {
  const t = f && f.departure && (f.departure.scheduledTime || f.departure.revisedTime);
  const s = t && (t.utc || t.local);
  const n = s ? Date.parse(s) : NaN;
  return isNaN(n) ? 0 : n;
}

function pickTime(block) {
  if (!block) return null;
  const revised = block.revisedTime || block.predictedTime || block.runwayTime;
  const scheduled = block.scheduledTime;
  return {
    scheduled: (scheduled && (scheduled.local || scheduled.utc)) || null,
    revised: (revised && (revised.local || revised.utc)) || null,
    scheduledUtc: (scheduled && scheduled.utc) || null,
    revisedUtc: (revised && revised.utc) || null,
  };
}

function normaliseAero(f) {
  const dep = f.departure || {};
  const arr = f.arrival || {};
  const dt = pickTime(dep);
  const at = pickTime(arr);
  const diffMin = (t) => {
    if (!t || !t.revisedUtc || !t.scheduledUtc) return null;
    const d = Math.round((Date.parse(t.revisedUtc) - Date.parse(t.scheduledUtc)) / 60000);
    return isNaN(d) ? null : d;
  };
  const delayMin = diffMin(at);
  // AeroDataBox routinely publishes a revised DEPARTURE long before (or instead of)
  // a revised arrival. Deriving delay from arrival alone therefore missed exactly
  // the delay that strands a traveller at the gate: no chip, no alert, no warning.
  const depDelayMin = diffMin(dt);
  return {
    number: (f.number || '').toString(),
    callSign: f.callSign || null,
    status: f.status || 'Unknown',
    airline: (f.airline && f.airline.name) || null,
    aircraftModel: (f.aircraft && f.aircraft.model) || null,
    aircraftReg: (f.aircraft && f.aircraft.reg) || null,
    delayMin: delayMin,
    depDelayMin: depDelayMin,
    departure: airportBlock(dep, dt),
    arrival: airportBlock(arr, at),
  };
}

function airportBlock(block, times) {
  const ap = block.airport || {};
  const loc = ap.location || {};
  return {
    iata: ap.iata || ap.icao || null,
    name: ap.shortName || ap.name || ap.municipalityName || null,
    terminal: block.terminal || null,
    gate: block.gate || null,
    baggageBelt: block.baggageBelt || null,
    scheduled: times ? times.scheduled : null,
    revised: times ? times.revised : null,
    scheduledUtc: times ? times.scheduledUtc : null,
    revisedUtc: times ? times.revisedUtc : null,
    lat: num(loc.lat != null ? loc.lat : loc.latitude),
    lon: num(loc.lon != null ? loc.lon : loc.longitude),
  };
}

async function fetchLive(opts) {
  const tries = [];
  if (opts.reg) {
    // Registration is the unique tail — authoritative, so don't also spend
    // requests on the shared call sign.
    tries.push('/v2/registration/' + encodeURIComponent(opts.reg));
  } else if (opts.callSign) {
    // The call sign AeroDataBox itself reported for this operation. It is the
    // airline's own identifier for the flight, so the two guesses below add
    // nothing but latency and requests against a 1 req/s tier.
    tries.push('/v2/callsign/' + encodeURIComponent(normNumber(opts.callSign)));
  } else {
    if (opts.callsignHint) tries.push('/v2/callsign/' + encodeURIComponent(normNumber(opts.callsignHint)));
    if (opts.number) tries.push('/v2/callsign/' + encodeURIComponent(opts.number));
  }
  const seen = {};
  for (const path of tries) {
    if (seen[path]) continue; seen[path] = 1;
    const r = await adsbFetch(path);
    if (r.ok && r.data && Array.isArray(r.data.ac) && r.data.ac.length) {
      return { data: normaliseLive(r.data.ac[0]), error: null };
    }
  }
  return { data: null, error: null };
}

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

// Parse an AeroDataBox UTC timestamp to epoch ms. These carry a real offset (or a
// trailing Z), unlike the reservation strings, so they are authoritative.
function toMs(s) {
  if (!s) return null;
  let t = String(s).replace(' ', 'T');
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';
  const n = Date.parse(t);
  return isNaN(n) ? null : n;
}

function normaliseLive(ac) {
  const alt = ac.alt_baro === 'ground' ? 'ground' : num(ac.alt_baro);
  return {
    hex: ac.hex || null,
    callSign: (ac.flight || '').trim() || null,
    reg: ac.r || null,
    type: ac.t || null,
    desc: ac.desc || null,
    lat: num(ac.lat),
    lon: num(ac.lon),
    altBaro: alt,
    groundSpeed: num(ac.gs),
    track: num(ac.track),
    verticalRate: num(ac.baro_rate) != null ? num(ac.baro_rate) : num(ac.geom_rate),
    squawk: ac.squawk || null,
    onGround: alt === 'ground',
    seenPos: num(ac.seen_pos),
  };
}

// Fetch status + live for one resolved leg. `win` gates the two calls:
//   win.status → query AeroDataBox (near enough departure to have data)
//   win.live   → query adsb.fi (flight plausibly airborne right now)
async function trackLeg(ctx, leg, key, win) {
  const errors = [];
  // Informational, non-failure markers. Deliberately NOT `errors`, so nothing
  // downstream (ttlFor's backoff, the widget's red error line) reads a choice the
  // plugin made on purpose as something having gone wrong.
  const notes = [];
  let status = null;
  if (win.status) {
    const aero = await fetchAero(ctx, leg.number, key, win.date);
    if (aero.error) errors.push('status: ' + aero.error);
    status = aero.data;
  }
  let live = { data: null };
  // Fetch the live position when the flight is plausibly up: inside the booking's
  // time window, OR whenever the date-pinned status itself says the flight is
  // airborne (then the aircraft is unambiguously this flight, so we can show it
  // even if the booking's clock times were rough). The correct-DAY guarantee
  // comes from the date-pinned status, not from requiring the plane to be up.
  const AIRBORNE = { EnRoute: 1, Departed: 1, Approaching: 1 };
  // A route handler has a hard 30 s budget, and adsb.fi calls are paced to respect
  // its 1 req/s tier. On a long multi-leg itinerary those two facts collide, so the
  // live position — the most optional part of the payload — is the first thing to
  // give way. The schedule, which is what the page is actually built from, is
  // already in hand by this point.
  const outOfTime = win.deadline != null && Date.now() > win.deadline;
  const liveWanted = win.live || (status && AIRBORNE[status.status]);
  const wantLive = !outOfTime && liveWanted;
  // A deliberate skip is NOT an error. Putting it in `errors` made ttlFor treat the
  // payload as failed and back the refresh off from 60 s to 10 minutes — freezing
  // the position of the leg the traveller is actually on — and showed the user a
  // red line implying the API had failed. Separate channel, ignored by ttlFor.
  if (outOfTime && liveWanted) notes.push('live: skipped (time budget)');
  if (wantLive) {
    live = await fetchLive({
      reg: status && status.aircraftReg,
      callSign: status && status.callSign,
      callsignHint: leg.callsign,
      number: leg.number,
    });
    if (live.error) errors.push('live: ' + live.error);
  }
  // The fetch above is gated on the BOOKING's clock, which can be hours out (the
  // reservation carries no timezone, and a booked time need not match the real
  // schedule). Once the date-pinned status gives us authoritative UTC instants,
  // re-check against those and DISCARD a position that cannot belong to this
  // flight — otherwise a flight departing tomorrow shows the aircraft currently
  // operating today's rotation, complete with an "in the air" chip and a nonsense
  // "0 % flown, in 28 h" progress read-out.
  if (live.data && status && !AIRBORNE[status.status]) {
    const H = 3600 * 1000;
    const depU = toMs(status.departure && (status.departure.revisedUtc || status.departure.scheduledUtc));
    const arrU = toMs(status.arrival && (status.arrival.revisedUtc || status.arrival.scheduledUtc));
    const now = Date.now();
    const plausible = (depU == null && arrU == null) ||
      (now >= (depU != null ? depU - 1 * H : -Infinity) && now <= (arrU != null ? arrU + 2 * H : Infinity));
    if (!plausible) live = { data: null };
  }
  // Destination weather at the arrival airport for the arrival day (host-cached,
  // free/tenant-free broker). Skipped once the flight is in the past.
  let weather = null;
  const arr = status && status.arrival;
  if (arr && arr.lat != null && arr.lon != null && win.status) {
    const wdate = (typeof arr.scheduled === 'string' ? arr.scheduled.slice(0, 10) : '') || win.date || null;
    const w = await attempt(() => ctx.weather.get(arr.lat, arr.lon, /^\d{4}-\d{2}-\d{2}$/.test(wdate || '') ? wdate : undefined), null);
    if (w && typeof w === 'object' && !w.error && typeof w.temp === 'number') {
      weather = {
        temp: Math.round(w.temp), main: w.main || null, description: w.description || null,
        tempMax: typeof w.temp_max === 'number' ? Math.round(w.temp_max) : null,
        tempMin: typeof w.temp_min === 'number' ? Math.round(w.temp_min) : null,
        precipProb: typeof w.precipitation_probability_max === 'number' ? Math.round(w.precipitation_probability_max) : null,
      };
    }
  }
  // Inbound aircraft: before departure, look up the ASSIGNED tail by registration.
  // If it's airborne elsewhere (finishing a previous rotation) we surface where it
  // is + how far from the departure airport — "your plane is on its way".
  let inbound = null;
  const notUp = status && !AIRBORNE[status.status] && status.status !== 'Arrived';
  if (status && status.aircraftReg && notUp && win.live && !live.data && !outOfTime) {
    const ri = await adsbFetch('/v2/registration/' + encodeURIComponent(status.aircraftReg));
    if (ri.ok && ri.data && Array.isArray(ri.data.ac) && ri.data.ac.length) {
      const a = normaliseLive(ri.data.ac[0]);
      if (a.lat != null && !a.onGround) inbound = a;
    }
  }
  return Object.assign({}, leg, { status, live: live.data, weather, inbound, errors, notes });
}

// --- key resolution: instance-wide, admin-managed -----------------------------
// The AeroDataBox key is instance-wide (one key serves every user). It can arrive
// two ways:
//   1. ctx.config.aerodatabox_key — set through TREK's admin-guarded plugin config
//      API (PUT /api/admin/plugins/flight-tracker/config) and injected decrypted.
//   2. the plugin's own kv row — written by the in-widget key field below.
// ctx.config always WINS: it is the explicitly admin-managed channel, and it is
// frozen at activation, so letting a kv row shadow it would silently override an
// admin's deliberate setting.
//
// TREK 3.4.0 fixed plugin admin-detection (TREK#1569): the proxy now builds the
// route user as `isAdmin: user.role === 'admin'`, so req.user.isAdmin is finally
// trustworthy — which is what makes the in-widget entry safe to re-enable. On
// 3.3 it was hardcoded from a non-existent `is_admin` column and always false;
// the manifest therefore requires >=3.4.0.
function isAdminUser(u) { return !!(u && (u.isAdmin || u.is_admin)); }
function canSetKey(ctx, user) { return isAdminUser(user); }

async function getKey(ctx) {
  if (ctx.config && ctx.config.aerodatabox_key) return String(ctx.config.aerodatabox_key);
  const rows = await attempt(() => ctx.db.query("SELECT v FROM kv WHERE k = 'aerodatabox_key'"), []);
  return (rows && rows[0] && rows[0].v) ? String(rows[0].v) : '';
}

// A non-reversible fingerprint, so "is this still the key RapidAPI rejected?" can be
// answered without ever writing the key itself into the quota table.
function keyFingerprint(key) {
  let h = 2166136261;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

// Resolve the key AND reconcile the sticky "this key was rejected" flag: a rotated
// key must get a fresh chance, or a typo would disable schedule data until someone
// found the quota table. Returns '' when there is no key at all.
async function getKeyChecked(ctx) {
  const key = await getKey(ctx);
  const fp = key ? keyFingerprint(key) : 0;
  const seen = await quotaGet(ctx, 'ada:invalid_for');
  if (seen !== fp) {
    await quotaSet(ctx, 'ada:invalid_for', fp);
    await quotaSet(ctx, 'ada:invalid', 0);
  }
  return key;
}

// --- core: build the combined payload for a reservation ----------------------

// AUTHORIZATION GATE. ctx.trips is the only host surface that membership-checks a
// read, so every route must pass through it BEFORE touching the plugin's own
// storage. That storage (ctx.db) is a single shared database with no per-user
// scoping, and reservation ids are sequential integers — so without this gate any
// authenticated user could enumerate ids and read another user's itinerary out of
// the cache, or write flight-number overrides into their reservations.
//
// Deliberately NOT wrapped in attempt(): swallowing RESOURCE_FORBIDDEN to null is
// precisely what turned a failed permission check into a successful request.
// Returns { resv } on success or { error } holding the response to send.
async function requireOwnedReservation(ctx, tripId, reservationId) {
  if (tripId == null || tripId === '') return { error: json(400, { error: 'tripId required' }) };
  let list;
  try {
    list = await ctx.trips.getReservations(Number(tripId));
  } catch (e) {
    const msg = String((e && e.message) || e);
    // The host prefixes rejections with the error code.
    if (/^(RESOURCE_FORBIDDEN|PERMISSION_DENIED)/.test(msg)) return { error: json(403, { error: 'forbidden' }) };
    return { error: json(502, { error: 'trip lookup failed' }) };
  }
  const resv = (list || []).find((x) => String(x.id) === String(reservationId));
  // Not a member of the trip, or the reservation is not in it — same answer either
  // way, so membership cannot be probed by comparing responses.
  if (!resv) return { error: json(404, { error: 'not found' }) };
  return { resv };
}

// `resv` is supplied by the caller and has ALREADY passed the membership gate —
// buildPayload never re-reads it, so there is no path here that bypasses the check.
async function buildPayload(ctx, tripId, reservationId, forcedNumber, resv) {
  const key = await getKeyChecked(ctx);
  const hasKey = !!key;

  // A manual/stored override replaces detection with a single leg.
  let overrideNumber = normNumber(forcedNumber);
  let source = overrideNumber ? 'manual' : 'none';
  if (!overrideNumber) {
    const rows = await attempt(() => ctx.db.query('SELECT flight_number FROM flights WHERE reservation_id = ?', reservationId), []);
    if (rows && rows[0] && rows[0].flight_number) { overrideNumber = normNumber(rows[0].flight_number); source = 'stored'; }
  }

  const bookingType = resv ? (resv.type || parseMeta(resv).type || null) : null;

  // Departure/arrival datetimes drive the countdown and the fetch windows.
  const H = 3600 * 1000;
  const dep = parseDateTime(resv && resv.reservation_time);
  const arr = parseDateTime(resv && resv.reservation_end_time);
  const now = Date.now();
  const depMs = dep && dep.ms;
  // No end time means we must guess the duration. The old guess of +6h declared a
  // 13h flight "past" while it was still in the air, which stopped polling, muted
  // every alert and dropped it from the trip warnings. Assume a long-haul instead:
  // being late to call a flight finished only costs a little polling, while being
  // early goes dark during the part of the trip that matters most.
  const arrMs = (arr && arr.ms) || (depMs ? depMs + 20 * H : null);
  const baseDate = dep && dep.date;
  // Both endpoints came from naive local strings, so they carry up to ±14h of
  // timezone error. Widen the fetch windows by that bound rather than letting a
  // long-haul departure out of Asia or the Americas fall outside them entirely.
  const SLACK = (dep && dep.estimated) ? 14 * H : 0;

  // phase: upcoming (>48h out) | active (within window) | past
  let phase = 'active';
  if (depMs && now < depMs - 48 * H - SLACK) phase = 'upcoming';
  else if (arrMs && now > arrMs + 6 * H + SLACK) phase = 'past';

  // AeroDataBox status: from 48h before departure until 6h after arrival
  // (or best-effort if we don't know the date). Saves quota on far-future flights.
  const statusWin = !depMs ? true : (now >= depMs - 48 * H - SLACK && now <= arrMs + 6 * H + SLACK);
  // adsb.fi live position: only while the aircraft is plausibly airborne — 1h
  // before departure to 2h after arrival. Kept TIGHT despite the timezone slack,
  // because a wrong-day match here is worse than a miss; trackLeg independently
  // fetches the live position whenever the (date-pinned) status says the aircraft
  // is airborne, which is the reliable signal when the clock estimate is off.
  const liveWin = !depMs ? true : (now >= depMs - 1 * H && now <= arrMs + 2 * H);
  // Map trip day ids -> dates, so a per-leg (possibly next-day) query hits the
  // right calendar day instead of the reservation-level date.
  const days = tripId ? await attempt(() => ctx.trips.getDays(Number(tripId)), []) : [];
  const dayDate = {};
  (days || []).forEach((d) => { if (d && d.id != null && d.date) dayDate[String(d.id)] = String(d.date).slice(0, 10); });
  const legDate = (l) => (l.depDayId != null && dayDate[String(l.depDayId)]) || l.localDepDate || baseDate || null;

  let rawLegs;
  if (overrideNumber) {
    rawLegs = [resolveLeg({ flight: overrideNumber, airline: null, from: null, to: null })];
    if (rawLegs[0] && !rawLegs[0].number) rawLegs[0].number = overrideNumber;
  } else {
    rawLegs = resv ? getFlightLegs(resv).map(resolveLeg) : [];
    if (rawLegs.length) source = 'detected';
  }

  const queryable = rawLegs.filter((l) => l.number);

  const booking = {
    // No PNR: a booking reference is bearer-ish for airline "manage my booking"
    // portals, and copying it into a second datastore bought only a subtitle the
    // user can already see on the reservation itself.
    type: bookingType, depMs: depMs || null, arrMs: arrMs || null, phase,
    origin: (queryable[0] && queryable[0].from) || null,
    dest: (queryable.length && queryable[queryable.length - 1].to) || null,
    legCount: queryable.length,
  };

  if (!queryable.length) {
    const applicable = !bookingType || bookingType === 'flight';
    // Nothing to track any more: drop any resolved legs we persisted earlier, so the
    // background job stops re-querying a flight this reservation no longer describes.
    await attempt(() => ctx.db.exec('DELETE FROM legs WHERE reservation_id = ?', reservationId));
    return { applicable, source: 'none', hasKey, legs: [], booking,
      hint: rawLegs.length ? rawLegs.map((l) => ({ airline: l.airline, from: l.from, to: l.to, rawFlight: l.rawFlight })) : null,
      updatedAt: Date.now() };
  }

  // Track legs SEQUENTIALLY to respect both APIs' 1 req/s free-tier ceiling
  // (bursting Promise.all over legs would trip rate limits). Each leg pins its own
  // date. A past/arrived leg is not re-queried live.
  const legs = [];
  // Leave headroom inside the host's 30 s route timeout. Past this point legs are
  // still tracked for schedule, but the paced adsb.fi lookups are skipped rather
  // than risking a 502 that would lose the whole payload, including the parts that
  // did resolve.
  const deadline = Date.now() + 20000;
  for (const l of queryable) {
    const win = { status: statusWin, live: liveWin, date: legDate(l), deadline: deadline };
    const tracked = await tryLog(ctx, 'trackLeg', () => trackLeg(ctx, l, key, win),
      Object.assign({}, l, { status: null, live: null, errors: ['failed'] }));
    legs.push(tracked);
  }

  // AeroDataBox returns true UTC instants. Once we have them they REPLACE the
  // naive estimates above, so the countdown, the phase and the client's polling
  // cadence stop depending on the reservation string's missing timezone.
  const firstUtc = toMs(legs[0] && legs[0].status && legs[0].status.departure &&
    (legs[0].status.departure.revisedUtc || legs[0].status.departure.scheduledUtc));
  const lastLeg = legs[legs.length - 1];
  const lastUtc = toMs(lastLeg && lastLeg.status && lastLeg.status.arrival &&
    (lastLeg.status.arrival.revisedUtc || lastLeg.status.arrival.scheduledUtc));
  if (firstUtc != null) { booking.depMs = firstUtc; booking.estimatedTimes = false; }
  if (lastUtc != null) booking.arrMs = lastUtc;
  if (firstUtc != null || lastUtc != null) {
    const d = booking.depMs, a = booking.arrMs;
    booking.phase = (d && now < d - 48 * H) ? 'upcoming' : ((a && now > a + 6 * H) ? 'past' : 'active');
  } else {
    booking.estimatedTimes = true;
  }

  // Every leg's errors, surfaced so an exhausted quota or a rejected key is
  // visible instead of looking identical to "this flight has no data".
  const errors = [];
  legs.forEach((l) => (l.errors || []).forEach((e) => { if (e && errors.indexOf(e) === -1) errors.push(e); }));
  const notes = [];
  legs.forEach((l) => (l.notes || []).forEach((n) => { if (n && notes.indexOf(n) === -1) notes.push(n); }));

  // Persist the RESOLVED identifiers. This is what makes a background refresh
  // possible at all: the cron job runs USERLESS, so it can never call
  // ctx.trips.getReservations/getDays to re-derive legs from the booking. Writing
  // the already-resolved number, call sign and pinned date down here means the job
  // only has to re-query, never re-detect. One row per leg, replaced wholesale.
  await tryLog(ctx, 'legs.persist', async () => {
    const ops = [{ sql: 'DELETE FROM legs WHERE reservation_id = ?', args: [reservationId] }];
    legs.forEach((l, i) => {
      ops.push({
        sql: 'INSERT OR REPLACE INTO legs (reservation_id, leg_index, trip_id, number, callsign, from_iata, to_iata, leg_date, dep_ms, arr_ms, updated_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [reservationId, i, tripId != null ? String(tripId) : null, l.number || '', l.callsign || '',
          l.from || '', l.to || '', legDate(l) || '',
          toMs(l.status && l.status.departure && (l.status.departure.revisedUtc || l.status.departure.scheduledUtc)) || booking.depMs || null,
          toMs(l.status && l.status.arrival && (l.status.arrival.revisedUtc || l.status.arrival.scheduledUtc)) || booking.arrMs || null,
          Date.now()],
      });
    });
    await ctx.db.tx(ops);   // atomic: never leave a reservation with half its legs
  });

  return {
    applicable: true, source, hasKey, legs, booking,
    errors: errors.slice(0, 4),
    notes: notes.slice(0, 4),
    // Surfaced so the widget can distinguish "no data for this flight" from
    // "your key was rejected" and from "the month's requests are used up".
    keyInvalid: hasKey ? await keyInvalid(ctx) : false,
    quotaRemaining: hasKey ? ((await quotaGet(ctx, 'ada:remaining')) || null) : null,
    updatedAt: Date.now(),
  };
}

// Cache lifetime as a curve on time-to-departure, not a three-way phase switch.
// "active" began 48h before departure and pinned the TTL at 60s for two full days
// — ~2900 lookups per reservation against a ~600/month quota, when nothing about a
// schedule moves that far out. Refresh fast only when the data actually changes:
// in the air, or close to departure.
function ttlFor(payload) {
  const M = 60 * 1000, H = 3600 * 1000;
  const b = (payload && payload.booking) || {};
  if (b.phase === 'past') return 6 * H;
  // A payload built while the API was failing must not inherit the fast TTL of a
  // healthy one: near departure that is a 60-second retry loop against a 429 or a
  // rejected key, forever. Back off instead — hard for a key/quota problem, which
  // no amount of retrying fixes, gently for a transient one.
  // Belt and braces: a payload cached by an earlier build may still carry the
  // informational skip marker inside `errors`, and it must not pin the TTL.
  const errs = ((payload && payload.errors) || []).filter((e) => !/^live: skipped/.test(String(e)));
  if (errs.length) {
    const terminal = errs.some((e) => /key rejected|monthly quota/i.test(String(e)));
    return terminal ? 6 * H : 10 * M;
  }
  const legs = (payload && payload.legs) || [];
  const moving = legs.some((l) => {
    const st = l && l.status && l.status.status;
    return st === 'EnRoute' || st === 'Departed' || st === 'Approaching' ||
      st === 'Boarding' || st === 'Diverted';
  });
  if (moving) return M;
  const dep = b.depMs;
  if (!dep) return 5 * M;                       // unknown departure: middle ground
  const untilDep = dep - Date.now();
  if (untilDep < 3 * H) return M;               // the hours that decide your day
  if (untilDep < 12 * H) return 5 * M;
  if (untilDep < 48 * H) return 30 * M;
  return 2 * H;                                 // far future: schedules barely move
}

// `tripId` here is always the VERIFIED trip from requireOwnedReservation — never
// the raw request value. The cache read is scoped by it as defence in depth, and
// the write persists it so the userless hooks (which cannot membership-check
// anything) can only ever be fed rows a member actually caused.
async function cachedPayload(ctx, tripId, reservationId, force, forcedNumber, resv) {
  const tid = tripId != null ? String(tripId) : null;
  let throttled = false;
  // A forced refresh skips the TTL and re-queries every leg, so it is the one path
  // a user can drive at will. The key is instance-wide, so an unthrottled button is
  // a way for one person to spend everybody's month. Serve the cache instead and
  // say so, rather than silently pretending the refresh happened.
  if (force && !forcedNumber) {
    const k = 'force:' + reservationId;
    const lastForced = await quotaGet(ctx, k);
    if (lastForced && (Date.now() - lastForced) < FORCE_COOLDOWN_MS) { force = false; throttled = true; }
    else await quotaSet(ctx, k, Date.now());
  }
  if (!force && !forcedNumber) {
    const rows = await attempt(() => ctx.db.query('SELECT payload, fetched_at FROM cache WHERE reservation_id = ? AND trip_id IS ?', reservationId, tid), []);
    if (rows && rows[0]) {
      try {
        const cached = JSON.parse(rows[0].payload);
        const fresh = throttled || (Date.now() - Number(rows[0].fetched_at)) < ttlFor(cached);
        // A cached payload built before/after the admin key was set/removed is
        // stale even within TTL: its hasKey (and thus its schedule data) no
        // longer matches reality. Rebuild when the key's presence has flipped.
        const keyNow = !!(await getKey(ctx));
        if (fresh && !!cached.hasKey === keyNow) return Object.assign(cached, { cached: true, throttled: throttled || undefined });
      } catch (_e) { /* refetch */ }
    }
  }
  const payload = await buildPayload(ctx, tripId, reservationId, forcedNumber, resv);
  await tryLog(ctx, 'cache.write', () => ctx.db.exec(
    'INSERT OR REPLACE INTO cache (reservation_id, trip_id, payload, fetched_at) VALUES (?, ?, ?, ?)',
    reservationId, tid, JSON.stringify(payload), Date.now()));
  return payload;
}

// --- server-rendered strings -------------------------------------------------
// Everything the HOST renders rather than the widget: push/bell notifications and
// the native trip warnings. These were hardcoded German regardless of locale, so
// an English user on an English TREK got German alerts — for the highest-stakes
// text the plugin produces, the one saying the flight is cancelled.
//
// ctx carries no locale: req.user is { id, username, isAdmin } and the userless
// hooks get no user at all. So the widget passes its own locale on /status and
// /refresh (it already receives one via trek:context), and anything without that
// context falls back to English rather than to German.
const SRV_STR = {
  en: {
    cancelled: 'Flight cancelled', diverted: 'Flight diverted',
    delayed: (m) => 'Delayed +' + m + ' min', depDelayed: (m) => 'Departure delayed +' + m + ' min',
    gate: (g) => 'Gate ' + g, departed: 'Departed', arrived: 'Landed',
    updates: 'Flight updates',
    wCancelled: 'cancelled', wDiverted: 'diverted', wDelayed: (m) => '+' + m + ' min late',
  },
  de: {
    cancelled: 'Flug annulliert', diverted: 'Flug umgeleitet',
    delayed: (m) => 'Verspätung +' + m + ' Min', depDelayed: (m) => 'Abflug +' + m + ' Min später',
    gate: (g) => 'Gate ' + g, departed: 'Gestartet', arrived: 'Gelandet',
    updates: 'Flug-Updates',
    wCancelled: 'annulliert', wDiverted: 'umgeleitet', wDelayed: (m) => '+' + m + ' Min verspätet',
  },
};
function srvStr(locale) {
  return String(locale || '').toLowerCase().indexOf('de') === 0 ? SRV_STR.de : SRV_STR.en;
}

// --- notifications (only possible with a bound user, i.e. from a route) -------
// TREK forbids a userless job from notifying, so we fire while the app is open:
// each poll diffs the flight state and, on a meaningful change, sends one
// deduplicated bell/email notification to the acting user.
async function maybeNotify(ctx, user, rid, payload, locale) {
  if (!user || !user.id || !payload || !payload.legs || !payload.legs.length) return;
  if (payload.booking && payload.booking.phase === 'past') return;
  // The user's own off switch. Previously the only way to stop these was for an
  // admin to remove the instance-wide key, which disabled the plugin for everyone.
  if (!(await userNotifyEnabled(ctx))) return;
  const threshold = await userDelayThreshold(ctx);
  const S = srvStr(locale);
  const uid = String(user.id);
  // Keyed by leg INDEX as well as number: an out-and-back itinerary, or the same
  // number flown on two dates, repeats a flight number. Keying by number alone
  // collapsed those into one map entry and diffed the wrong leg against it.
  const cur = payload.legs.map((l, i) => {
    const s = l.status;
    return { k: i + ':' + (l.number || ''), n: l.number,
      st: s ? s.status : null,
      d: s && s.delayMin != null ? Math.round(s.delayMin / 5) * 5 : null,
      // Departure delay is part of the signature, so a 10:00 -> 12:00 slip is a
      // change worth alerting on even when the arrival estimate has not moved.
      dd: s && s.depDelayMin != null ? Math.round(s.depDelayMin / 5) * 5 : null,
      g: s && s.arrival ? (s.arrival.gate || null) : null,
      dg: s && s.departure ? (s.departure.gate || null) : null };
  });
  const prevRows = await attempt(() => ctx.db.query('SELECT sig FROM notif_state WHERE rid = ? AND uid = ?', rid, uid), []);
  const prev = prevRows && prevRows[0] ? prevRows[0].sig : null;
  let prevArr = []; try { prevArr = JSON.parse(prev); } catch (_e) { prevArr = []; }
  const old = {};
  // Tolerate a signature written by 1.x, which had no `k`: fall back to the number
  // so the first poll after an upgrade is not read as "everything just changed".
  (prevArr || []).forEach((o, i) => { if (o) old[o.k || (i + ':' + (o.n || ''))] = o; });

  // A leg with no status right now (API timeout, 429, key just removed, or simply
  // outside the fetch window) must NOT overwrite what we knew: storing all-nulls as
  // the baseline made the next successful poll look like a fresh gate assignment
  // and a fresh departure, firing alerts for events that never happened. Carry the
  // previous entry forward instead, so the diff is only ever against real data.
  const merged = cur.map((c) => (c.st == null && old[c.k]) ? old[c.k] : c);
  const sig = JSON.stringify(merged);
  if (prev == null) {
    // First sighting: record the baseline, never notify about it.
    await tryLog(ctx, 'notif.baseline', () => ctx.db.exec('INSERT OR REPLACE INTO notif_state (rid, uid, sig) VALUES (?, ?, ?)', rid, uid, sig));
    return;
  }
  if (prev === sig) return;

  // CLAIM the transition with a compare-and-swap before sending. Two concurrent
  // polls (two tabs, or the 60s cadence overlapping a manual refresh) would
  // otherwise both read the same `prev`, both decide to notify, and both send —
  // burning two of the 100 daily sends on one duplicate alert.
  const claim = await tryLog(ctx, 'notif.claim',
    () => ctx.db.exec('UPDATE notif_state SET sig = ? WHERE rid = ? AND uid = ? AND sig = ?', sig, rid, uid, prev),
    { changes: 0 });
  if (!claim || !claim.changes) return;   // someone else already handled this transition

  // Collect EVERY notify-worthy change across all legs (don't mask a second one),
  // then send a single combined notification.
  const msgs = [];
  for (const c of merged) {
    const o = old[c.k] || {};
    if (c.st == null) continue;               // nothing known this round
    let msg = null;
    if ((c.st === 'Canceled' || c.st === 'Cancelled') && o.st !== c.st) msg = S.cancelled;
    else if (c.st === 'Diverted' && o.st !== c.st) msg = S.diverted;
    else if (c.d != null && c.d >= threshold && c.d !== o.d) msg = S.delayed(c.d);
    else if (c.dd != null && c.dd >= threshold && c.dd !== o.dd) msg = S.depDelayed(c.dd);
    else if ((c.dg || c.g) && (c.dg || c.g) !== (o.dg || o.g)) msg = S.gate(c.dg || c.g);
    else if (c.st === 'Departed' && o.st !== c.st) msg = S.departed;
    else if (c.st === 'Arrived' && o.st !== c.st) msg = S.arrived;
    if (msg) msgs.push({ n: c.n, msg: msg });
  }
  if (!msgs.length) return;   // the signature moved, but nothing worth an alert

  // SEND FIRST, KEEP THE CLAIM ONLY IF IT LANDS. The old order advanced the
  // baseline and then sent inside attempt(): if the send failed — the 100/day
  // notify budget, a transient HOST_ERROR, a revoked grant — the next poll saw
  // prev === sig and returned, and the alert was gone for good. Since the highest-
  // stakes string this plugin produces is "Flight cancelled", roll the baseline
  // back on failure so the next poll tries again.
  try {
    if (msgs.length === 1) {
      await ctx.notify.send({ title: withSpaceNum(msgs[0].n), body: msgs[0].msg, scope: 'user', targetId: user.id });
    } else {
      const body = msgs.map((m) => withSpaceNum(m.n) + ': ' + m.msg).join(' · ').slice(0, 990);
      await ctx.notify.send({ title: S.updates, body: body, scope: 'user', targetId: user.id });
    }
  } catch (e) {
    ctx.log.warn('notify.send failed — rolling the alert baseline back so it retries', { error: String((e && e.message) || e) });
    await attempt(() => ctx.db.exec('UPDATE notif_state SET sig = ? WHERE rid = ? AND uid = ? AND sig = ?', prev, rid, uid, sig));
  }
}

function toIsoUtc(s) {
  if (!s) return null;
  let t = String(s).replace(' ', 'T');
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';
  return t;
}
function hhmm(s) { const m = String(s || '').match(/(\d{1,2}):(\d{2})/); return m ? (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2] : ''; }

// "T2/G A12" style detail for the PDF, from whatever the block actually has.
function gateOf(block) {
  if (!block) return '';
  const bits = [];
  if (block.terminal) bits.push('T' + block.terminal);
  if (block.gate) bits.push('Gate ' + block.gate);
  if (block.baggageBelt) bits.push('Belt ' + block.baggageBelt);
  return bits.length ? '(' + bits.join(' ') + ')' : '';
}

// Record the acting user's flights (UTC times) so the userless calendarSource
// hook can surface them per-user. Keyed by (user, reservation).
async function recordUserFlight(ctx, user, tripId, rid, payload) {
  if (!user || !user.id || !payload) return;
  const uid = String(user.id);
  const events = [];
  if (payload.applicable !== false && Array.isArray(payload.legs)) {
    payload.legs.forEach((l, i) => {
      const s = l.status; if (!s) return;
      const start = toIsoUtc((s.departure && (s.departure.scheduledUtc || s.departure.revisedUtc)) || null);
      const end = toIsoUtc((s.arrival && (s.arrival.revisedUtc || s.arrival.scheduledUtc)) || null);
      if (!start || !end) return;
      const from = l.from || (s.departure && s.departure.iata) || '';
      const to = l.to || (s.arrival && s.arrival.iata) || '';
      events.push({ id: 'ft-' + rid + '-' + i, title: withSpaceNum(l.number) + (from && to ? ' ' + from + '→' + to : ''), start: start, end: end });
    });
  }
  if (events.length) {
    await attempt(() => ctx.db.exec('INSERT OR REPLACE INTO cal_events (uid, rid, trip_id, data, updated_at) VALUES (?, ?, ?, ?, ?)', uid, String(rid), tripId != null ? String(tripId) : null, JSON.stringify(events), Date.now()));
    return;
  }
  // Zero events is ambiguous: it can mean "not a flight any more" OR "the status
  // lookup failed / we are outside the fetch window". Deleting on the second case
  // silently removed a real flight from TREK's calendar, so only reconcile when we
  // POSITIVELY know there is nothing to show.
  const confident = payload.applicable === false ||
    (Array.isArray(payload.legs) && payload.legs.length === 0 && !(payload.errors || []).length);
  if (confident) await attempt(() => ctx.db.exec('DELETE FROM cal_events WHERE uid = ? AND rid = ?', uid, String(rid)));
}

// --- warning provider (userless): surfaces delays/cancellations in the planner
// from the freshest cached payloads (no extra API calls — quota-safe) ----------
async function getTripWarnings(tripId, ctx) {
  const out = [];
  const rows = await attempt(() => ctx.db.query('SELECT payload, fetched_at FROM cache WHERE trip_id = ?', String(tripId)), []);
  const now = Date.now();
  // Provider hooks run with the acting user bound, so the reader's own threshold
  // applies here too — a warning and a notification now agree about what counts as
  // a delay. In a context with no user this resolves to the documented default.
  const threshold = Math.max(await userDelayThreshold(ctx), 1);
  for (const r of rows || []) {
    if (now - Number(r.fetched_at) > 30 * 60 * 1000) continue; // ignore stale
    let p; try { p = JSON.parse(r.payload); } catch (_e) { continue; }
    if (!p || p.applicable === false || !Array.isArray(p.legs)) continue;
    if (p.booking && p.booking.phase === 'past') continue;
    for (const lg of p.legs) {
      const s = lg.status; if (!s) continue;
      const from = lg.from || (s.departure && s.departure.iata) || '';
      const to = lg.to || (s.arrival && s.arrival.iata) || '';
      const route = from && to ? ' ' + from + '→' + to : '';
      const num = withSpaceNum(lg.number);
      // The host gives a hook no locale, so English is the documented default
      // rather than the previous German-only text.
      const S = srvStr(null);
      if (s.status === 'Canceled' || s.status === 'Cancelled') out.push({ level: 'error', message: num + route + ' ' + S.wCancelled });
      else if (s.status === 'Diverted') out.push({ level: 'error', message: num + route + ' ' + S.wDiverted });
      else if (s.delayMin != null && s.delayMin >= threshold) out.push({ level: 'warning', message: num + route + ' ' + S.wDelayed(s.delayMin) });
      else if (s.depDelayMin != null && s.depDelayMin >= threshold) out.push({ level: 'warning', message: num + route + ' ' + S.wDelayed(s.depDelayMin) });
    }
    if (out.length >= 12) break;
  }
  return out.slice(0, 12);
}

// Read every fresh cached payload for a trip, newest-usable first. The shared
// entry point for the trip-scoped hooks below, so they cannot drift apart on what
// counts as "fresh" or on how a corrupt row is handled.
async function freshTripPayloads(ctx, tripId, maxAgeMs) {
  const rows = await attempt(() => ctx.db.query('SELECT reservation_id, payload, fetched_at FROM cache WHERE trip_id = ?', String(tripId)), []);
  const now = Date.now();
  const out = [];
  for (const r of rows || []) {
    if (now - Number(r.fetched_at) > maxAgeMs) continue;
    let p; try { p = JSON.parse(r.payload); } catch (_e) { continue; }
    if (!p || p.applicable === false || !Array.isArray(p.legs) || !p.legs.length) continue;
    out.push({ rid: r.reservation_id, payload: p, fetchedAt: Number(r.fetched_at) });
  }
  return out;
}

// Short human label for a leg's current state, in the host's default language.
// Returns null when there is nothing worth saying.
function legHeadline(leg, threshold) {
  const s = leg && leg.status;
  if (!s) return null;
  const S = srvStr(null);
  if (s.status === 'Canceled' || s.status === 'Cancelled') return { text: S.cancelled, tone: 'danger', rank: 3 };
  if (s.status === 'Diverted') return { text: S.diverted, tone: 'danger', rank: 3 };
  const d = (s.delayMin != null && s.delayMin >= threshold) ? s.delayMin
    : ((s.depDelayMin != null && s.depDelayMin >= threshold) ? s.depDelayMin : null);
  if (d != null) return { text: S.wDelayed(d), tone: 'warn', rank: 2 };
  if (s.status === 'Arrived') return { text: S.arrived, tone: 'success', rank: 0 };
  if (s.status === 'EnRoute' || s.status === 'Departed' || s.status === 'Approaching') return { text: S.departed, tone: 'success', rank: 1 };
  const gate = (s.departure && s.departure.gate) || null;
  if (gate) return { text: S.gate(gate), tone: 'default', rank: 1 };
  return null;
}

// --- map layer provider (TREK 4): the route itself, not just its endpoints -----
// mapMarkerProvider already pins the airports and the aircraft. What was missing is
// the line between them — and it must be a GREAT CIRCLE: FRA->NRT drawn as a
// straight segment on a Mercator map runs over Iran instead of Siberia. Where a
// live position is known the flown part is drawn solid and the rest dashed, which
// is the same read the widget's own minimap gives.
async function getTripLayers(tripId, ctx) {
  const rows = await freshTripPayloads(ctx, tripId, 6 * 3600 * 1000);
  const features = [];
  const VERTICES_PER_LEG = 48;   // host budget is 8000 vertices per plugin
  for (const { payload } of rows) {
    if (payload.booking && payload.booking.phase === 'past') continue;
    for (const lg of payload.legs) {
      const s = lg.status; if (!s) continue;
      const dep = s.departure, arr = s.arrival;
      if (!dep || !arr || dep.lat == null || dep.lon == null || arr.lat == null || arr.lon == null) continue;
      const label = withSpaceNum(lg.number) + (dep.iata && arr.iata ? ' ' + dep.iata + '→' + arr.iata : '');
      const pts = gcPoints({ lat: dep.lat, lon: dep.lon }, { lat: arr.lat, lon: arr.lon }, VERTICES_PER_LEG);
      const live = lg.live;
      const cancelled = s.status === 'Canceled' || s.status === 'Cancelled' || s.status === 'Diverted';
      // Each style becomes one or more polylines: a path crossing the antimeridian
      // has to be cut there, or it is drawn the long way round the world.
      const emit = (segment, style) => {
        splitAntimeridian(segment).forEach((part) => {
          features.push(Object.assign({ type: 'polyline', points: part, label: label }, style));
        });
      };
      if (live && live.lat != null && !live.onGround && !cancelled) {
        // Split at the point nearest the aircraft: flown solid, remaining dashed.
        // The longitude difference must be WRAPPED — comparing raw values puts an
        // aircraft at 175E about 354 degrees from a vertex at 179W, so the break
        // landed at the wrong end of the route on exactly the trans-Pacific legs.
        let best = 0, bestD = Infinity;
        pts.forEach((p, i) => {
          const dLat = p[0] - live.lat, dLon = lonDelta(p[1], live.lon);
          const d2 = dLat * dLat + dLon * dLon;
          if (d2 < bestD) { bestD = d2; best = i; }
        });
        if (best >= 1) emit(pts.slice(0, best + 1), { tone: 'success', width: 3, dash: 'solid', opacity: 0.9 });
        if (best <= pts.length - 2) emit(pts.slice(best), { tone: 'default', width: 2, dash: 'dash', opacity: 0.6 });
      } else {
        emit(pts, { tone: cancelled ? 'danger' : 'default', width: 2, dash: cancelled ? 'dot' : 'dash', opacity: 0.7 });
      }
      if (features.length >= 24) break;   // well inside the 150-feature / 8000-vertex budget
    }
    if (features.length >= 24) break;
  }
  if (!features.length) return [];
  return [{ id: 'ft-routes', name: 'Flight routes', features: features }];
}

// --- day schedule provider (TREK 4): flights in the day plan -------------------
// A flight is the single biggest block of time in a travel day, and until now the
// day plan knew nothing about it — the route footer's total ignored the eight hours
// you spend in the air. Each leg contributes one row anchored to its booking, with
// its block time folded into the day total.
async function getDaySchedule(tripId, ctx) {
  const rows = await freshTripPayloads(ctx, tripId, 24 * 3600 * 1000);
  const threshold = Math.max(await userDelayThreshold(ctx), 1);
  const out = [];
  for (const { rid, payload } of rows) {
    payload.legs.forEach((lg, i) => {
      // No day id means we do not know WHICH day this belongs to. The host checks
      // dayId against the trip's own days and drops a mismatch, so guessing here
      // would just be a silent no-op — skip instead.
      if (lg.depDayId == null) return;
      const s = lg.status;
      const from = lg.from || (s && s.departure && s.departure.iata) || '';
      const to = lg.to || (s && s.arrival && s.arrival.iata) || '';
      const depMs = toMs(s && s.departure && (s.departure.revisedUtc || s.departure.scheduledUtc));
      const arrMs = toMs(s && s.arrival && (s.arrival.revisedUtc || s.arrival.scheduledUtc));
      let minutes = (depMs != null && arrMs != null) ? Math.round((arrMs - depMs) / 60000) : null;
      if (minutes != null && (minutes < 1 || minutes > 1440)) minutes = null;   // host clamps 1..1440
      const head = legHeadline(lg, threshold);
      const label = [withSpaceNum(lg.number), from && to ? from + '→' + to : (from || to || ''), head && head.text]
        .filter(Boolean).join(' · ').slice(0, 120);
      const item = { id: 'ft-' + rid + '-' + i, dayId: Number(lg.depDayId), reservationId: Number(rid), label: label };
      if (minutes != null) item.minutes = minutes;
      if (head && head.tone !== 'default') item.tone = head.tone;
      out.push(item);
    });
    if (out.length >= 60) break;   // host cap
  }
  return out.slice(0, 60);
}

// --- table contributor (TREK 4): status where people actually scan for problems -
// The reservations table is where a traveller looks down a trip's bookings. Until
// now the flight status lived only inside the expanded card.
async function getTableContributions(view, tripId, ctx) {
  if (view !== 'reservations') return [];
  const rows = await freshTripPayloads(ctx, tripId, 30 * 60 * 1000);
  const threshold = Math.max(await userDelayThreshold(ctx), 1);
  const out = [];
  for (const { rid, payload } of rows) {
    // One cell per reservation: the most serious thing happening across its legs,
    // so a two-leg itinerary with one cancellation reads as cancelled.
    let worst = null, worstLeg = null;
    payload.legs.forEach((lg) => {
      const h = legHeadline(lg, threshold);
      if (h && (!worst || h.rank > worst.rank)) { worst = h; worstLeg = lg; }
    });
    if (!worst) continue;
    out.push({
      kind: 'column', entityId: Number(rid), id: 'ft-status-' + rid,
      label: 'Flight', icon: 'Plane',
      value: (withSpaceNum(worstLeg.number) + ' · ' + worst.text).slice(0, 120),
      tone: worst.tone,
    });
    if (out.length >= 20) break;   // host cap per entity view
  }
  return out;
}

// --- trip card provider (TREK 4): the only surface that reaches you early -------
// A delay is actionable while you are still deciding whether to leave for the
// airport — i.e. before you open the trip at all. This is the one badge that gets
// there in time.
async function getTripCards(tripIds, ctx) {
  const ids = (tripIds || []).map((t) => String(t)).filter((t) => /^\d+$/.test(t)).slice(0, 60);
  if (!ids.length) return [];
  const threshold = Math.max(await userDelayThreshold(ctx), 1);
  // ONE query for every card on screen. A query per trip would be one ctx RPC per
  // dashboard card, and the host's per-plugin RPC bucket is 20/s with a burst of
  // 60 — a dashboard with a few dozen trips would throttle the plugin (and, while
  // throttled, everything else it is doing) purely to draw badges.
  const rows = await attempt(() => ctx.db.query(
    'SELECT trip_id, payload, fetched_at FROM cache WHERE trip_id IN (' + ids.map(() => '?').join(',') + ')',
    ...ids), []);
  const now = Date.now();
  const best = new Map();
  for (const r of rows || []) {
    if (now - Number(r.fetched_at) > 30 * 60 * 1000) continue;   // a stale badge is worse than none
    let p; try { p = JSON.parse(r.payload); } catch (_e) { continue; }
    if (!p || p.applicable === false || !Array.isArray(p.legs)) continue;
    if (p.booking && p.booking.phase === 'past') continue;
    for (const lg of p.legs) {
      const h = legHeadline(lg, threshold);
      // Only disruptions and in-flight legs earn a dashboard badge; "Gate A12" is
      // not worth the space, and a badge for every healthy flight is noise.
      if (!h || h.rank < 1) continue;
      const prev = best.get(String(r.trip_id));
      if (!prev || h.rank > prev.head.rank) best.set(String(r.trip_id), { head: h, leg: lg });
    }
  }
  const out = [];
  for (const id of ids) {
    const hit = best.get(id);
    if (!hit) continue;
    out.push({
      tripId: Number(id), id: 'ft-' + id, icon: 'Plane',
      label: withSpaceNum(hit.leg.number).slice(0, 40),
      value: hit.head.text.slice(0, 60),
      tone: hit.head.tone,
    });
    if (out.length >= 240) break;   // host cap per provider
  }
  return out;
}

// Markers on TREK's own trip map (userless, per-trip): departure/arrival airports
// and the live aircraft, from the freshest cache.
async function getTripMarkers(tripId, ctx) {
  const out = [];
  const rows = await attempt(() => ctx.db.query('SELECT reservation_id, payload, fetched_at FROM cache WHERE trip_id = ?', String(tripId)), []);
  const now = Date.now();
  // Airports are merged ACROSS reservations, not just across a single itinerary's
  // legs: a hub appears as both an arrival and a departure, and a round trip's
  // origin is also its return destination, so each stacked two pins that hid one
  // another. Keyed by IATA, falling back to rounded coordinates.
  const airports = Object.create(null);
  const addAirport = (block, num) => {
    if (!block || block.lat == null || block.lon == null) return;
    const key = block.iata || (Math.round(block.lat * 100) + ',' + Math.round(block.lon * 100));
    const existing = airports[key];
    if (existing) {
      if (existing._flights.indexOf(num) === -1) existing._flights.push(num);
      return;
    }
    airports[key] = {
      id: 'ft-ap-' + String(key).replace(/[^A-Za-z0-9]/g, ''),
      lat: block.lat, lng: block.lon, label: block.iata || '',
      _name: block.name || block.iata || '', _flights: [num],
    };
  };
  for (const r of rows || []) {
    if (now - Number(r.fetched_at) > 6 * 3600 * 1000) continue;
    let p; try { p = JSON.parse(r.payload); } catch (_e) { continue; }
    if (!p || p.applicable === false || !Array.isArray(p.legs)) continue;
    const rid = r.reservation_id;
    p.legs.forEach((l, i) => {
      const s = l.status, num = withSpaceNum(l.number);
      if (s) { addAirport(s.departure, num); addAirport(s.arrival, num); }
      if (l.live && l.live.lat != null && !l.live.onGround) out.push({ id: 'ft-' + rid + '-' + i + '-p', lat: l.live.lat, lng: l.live.lon, label: num, popupText: (l.live.desc || l.live.type || 'Aircraft') + (l.live.altBaro != null && l.live.altBaro !== 'ground' ? ' · ' + Math.round(l.live.altBaro) + ' ft' : ''), icon: 'plane', tone: 'accent' });
    });
    if (out.length >= 150) break;
  }
  // Airports FIRST. The old order pushed aircraft into `out` while collecting
  // airports separately, then broke on the cap and appended airports afterwards —
  // so on a trip busy enough to reach the limit, the final slice() cut exactly the
  // stable, always-useful airport pins the de-duplication above exists to build,
  // and kept transient aircraft positions instead. The host cap is 200 per plugin.
  const pins = Object.keys(airports).map((k) => {
    const a = airports[k];
    return { id: a.id, lat: a.lat, lng: a.lng, label: a.label,
      popupText: a._flights.join(', ') + (a._name ? ' — ' + a._name : '') };
  });
  return pins.concat(out).slice(0, 200);
}

// A section for the exported trip PDF (userless, per-trip).
async function getTripPdf(tripId, ctx) {
  const rows = await attempt(() => ctx.db.query('SELECT payload, fetched_at FROM cache WHERE trip_id = ?', String(tripId)), []);
  const now = Date.now();
  const body = [];
  for (const r of rows || []) {
    if (now - Number(r.fetched_at) > 24 * 3600 * 1000) continue;
    let p; try { p = JSON.parse(r.payload); } catch (_e) { continue; }
    if (!p || p.applicable === false || !Array.isArray(p.legs)) continue;
    p.legs.forEach((l) => {
      const s = l.status;
      const from = l.from || (s && s.departure && s.departure.iata) || '';
      const to = l.to || (s && s.arrival && s.arrival.iata) || '';
      const depRaw = (s && s.departure && (s.departure.revised || s.departure.scheduled)) || l.depTime || '';
      const dep = hhmm(depRaw);
      const arrT = hhmm((s && s.arrival && (s.arrival.revised || s.arrival.scheduled)) || l.arrTime || '');
      // A PDF is what you carry when you have no app and no network, so it should
      // hold the details you would otherwise open the app for. The payload already
      // has terminal, gate, belt and seat — none of it used to reach the page.
      const date = (typeof depRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(depRaw)) ? depRaw.slice(0, 10) : '';
      const depDetail = [dep, gateOf(s && s.departure)].filter(Boolean).join(' ');
      const arrDetail = [arrT, gateOf(s && s.arrival)].filter(Boolean).join(' ');
      body.push([date, withSpaceNum(l.number), (from && to ? from + ' → ' + to : (from || to || '')),
        depDetail, arrDetail, l.seat || '', (s && s.status) || '']);
    });
    if (body.length >= 50) break;
  }
  if (!body.length) return [];
  return [{ title: 'Flights', table: {
    headers: ['Date', 'Flight', 'Route', 'Departure', 'Arrival', 'Seat', 'Status'], rows: body } }];
}

// The acting user's flight events for TREK's calendar (userless; reads what the
// user's own views recorded in cal_events).
async function getUserCalendar(userId, start, end, ctx) {
  const rows = await attempt(() => ctx.db.query('SELECT data FROM cal_events WHERE uid = ?', String(userId)), []);
  const s = Date.parse(start), e = Date.parse(end), out = [];
  for (const r of rows || []) {
    let evs; try { evs = JSON.parse(r.data); } catch (_e) { continue; }
    (evs || []).forEach((ev) => {
      const es = Date.parse(ev.start), ee = Date.parse(ev.end);
      if (isNaN(es) || isNaN(ee)) return;
      if (isNaN(s) || isNaN(e) || (ee >= s && es <= e)) out.push({ id: ev.id, title: ev.title, start: ev.start, end: ev.end, allDay: false });
    });
    if (out.length >= 200) break;
  }
  return out.slice(0, 200);
}

function json(status, body) {
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

// Nudge every other member's open reservation card to re-fetch. Reaches their frame
// as a NAME-ONLY `trek:event` (`plugin:flight-tracker:updated`) — the payload is
// never delivered — and only on frames that carry a tripId, which the
// reservation-detail slot always does. Route-only: it needs the acting user, so the
// background job cannot use it. Unlike a missing hook grant this is not a silent
// no-op; without ws:broadcast:trip the call rejects, so it is worth logging.
async function broadcastUpdate(ctx, tripId) {
  await tryLog(ctx, 'ws.broadcastToTrip', () => ctx.ws.broadcastToTrip(Number(tripId), 'updated', {}));
}

// Ids arrive as unvalidated strings. The membership gate coerces with Number(), so
// '07', ' 7' and '7.0' all pass it for trip 7 — but the cache row was then written
// with the RAW string as trip_id, while the trip hooks query with the host's own
// String(tripId), i.e. '7'. The row matched nothing, and the trip warnings, map
// markers, layers and PDF section silently vanished for that trip with no error
// anywhere. Normalise once, at the edge, and reject anything that is not an id.
function intId(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function readParams(req) {
  const q = req.query || {};
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  // NOTE: apiKey is deliberately absent — it must never be read from the query
  // string, where proxies, host logs and browser history would persist it in
  // plaintext. /key reads it from the body only.
  const rawTrip = b.tripId != null ? b.tripId : q.tripId;
  const rawResv = b.reservationId != null ? b.reservationId : q.reservationId;
  return {
    tripId: intId(rawTrip),
    reservationId: intId(rawResv),
    badId: (rawTrip != null && rawTrip !== '' && intId(rawTrip) == null) ||
           (rawResv != null && rawResv !== '' && intId(rawResv) == null),
    flightNumber: b.flightNumber != null ? b.flightNumber : q.flightNumber,
    // Display locale, forwarded by the widget so host-rendered notifications match
    // the language the user is reading TREK in.
    locale: b.locale != null ? b.locale : q.locale,
  };
}

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate('001_flights',
      'CREATE TABLE IF NOT EXISTS flights (reservation_id TEXT PRIMARY KEY, trip_id TEXT, flight_number TEXT, updated_at INTEGER)');
    await ctx.db.migrate('002_cache',
      'CREATE TABLE IF NOT EXISTS cache (reservation_id TEXT PRIMARY KEY, payload TEXT, fetched_at INTEGER)');
    await ctx.db.migrate('003_kv',
      'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    // The only ALTER in the set, and the only migration that is not self-guarding:
    // re-running it throws "duplicate column name: trip_id", and a throw in onLoad
    // fails ACTIVATION outright. TREK keeps a persistent migration ledger so it
    // never re-runs, but `trek-plugin dev` keeps its ledger in memory while the
    // SQLite file persists — so every dev boot after the first used to kill the
    // plugin on load. Probe for the column instead of trusting the ledger; SQLite
    // has no "ADD COLUMN IF NOT EXISTS" and PRAGMA is refused by the host's SQL guard.
    const hasTripId = await attempt(async () => { await ctx.db.query('SELECT trip_id FROM cache LIMIT 1'); return true; }, false);
    if (!hasTripId) await ctx.db.migrate('004_cache_trip', 'ALTER TABLE cache ADD COLUMN trip_id TEXT');
    await ctx.db.migrate('005_notif',
      'CREATE TABLE IF NOT EXISTS notif_state (rid TEXT, uid TEXT, sig TEXT, PRIMARY KEY (rid, uid))');
    await ctx.db.migrate('006_cal',
      'CREATE TABLE IF NOT EXISTS cal_events (uid TEXT, rid TEXT, trip_id TEXT, data TEXT, updated_at INTEGER, PRIMARY KEY (uid, rid))');
    // cache's PRIMARY KEY is reservation_id and trip_id was added later by ALTER
    // with no index, so every planner load, map render and PDF export full-scanned
    // the table. Same for notif_state, which the GDPR erase path now queries by uid.
    await ctx.db.migrate('007_idx_cache_trip', 'CREATE INDEX IF NOT EXISTS idx_cache_trip ON cache(trip_id)');
    await ctx.db.migrate('008_idx_notif_uid', 'CREATE INDEX IF NOT EXISTS idx_notif_uid ON notif_state(uid)');
    // Resolved leg identifiers — see buildPayload. This is what lets the userless
    // background job re-query a flight it can never re-derive from the booking.
    await ctx.db.migrate('009_legs',
      'CREATE TABLE IF NOT EXISTS legs (reservation_id TEXT, leg_index INTEGER, trip_id TEXT, number TEXT, callsign TEXT,'
      + ' from_iata TEXT, to_iata TEXT, leg_date TEXT, dep_ms INTEGER, arr_ms INTEGER, updated_at INTEGER,'
      + ' last_refresh_at INTEGER,'
      + ' PRIMARY KEY (reservation_id, leg_index))');
    await ctx.db.migrate('010_idx_legs_dep', 'CREATE INDEX IF NOT EXISTS idx_legs_dep ON legs(dep_ms)');
    // Counters for the AeroDataBox governor: monthly spend, the sticky
    // rejected-key flag and its fingerprint, per-reservation force cooldowns.
    await ctx.db.migrate('011_quota',
      'CREATE TABLE IF NOT EXISTS quota (k TEXT PRIMARY KEY, n INTEGER, updated_at INTEGER)');
    ctx.log.info('flight-tracker loaded');
  },

  hooks: {
    // Fail-safe: a throw or a timeout in any of these is skipped by the host, never
    // fatal. They read only the plugin's OWN cache, so none of them needs a trip
    // read — which also means they work identically whether or not the host binds
    // an acting user. The background job below is what keeps that cache warm; before
    // it existed, every one of these was blank unless a member had just opened the
    // exact reservation card.
    warningProvider: {
      async getWarnings(tripId, ctx) { return attempt(() => getTripWarnings(tripId, ctx), []); },
    },
    mapMarkerProvider: {
      async getMarkers(tripId, ctx) { return attempt(() => getTripMarkers(tripId, ctx), []); },
    },
    // NEW in TREK 4 — the great-circle route between the airports.
    mapLayerProvider: {
      async getLayers(tripId, ctx) { return attempt(() => getTripLayers(tripId, ctx), []); },
    },
    // NEW in TREK 4 — flights and their block time in the day plan.
    dayScheduleProvider: {
      async getSchedule(tripId, ctx) { return attempt(() => getDaySchedule(tripId, ctx), []); },
    },
    // NEW — live status column on the reservations table.
    tableContributor: {
      async getContributions(view, tripId, ctx) { return attempt(() => getTableContributions(view, tripId, ctx), []); },
    },
    // NEW — the delay badge on the dashboard trip card, the only surface that
    // reaches the traveller before they open the trip.
    tripCardProvider: {
      async getCards(tripIds, ctx) { return attempt(() => getTripCards(tripIds, ctx), []); },
    },
    pdfSectionProvider: {
      async getSections(tripId, ctx) { return attempt(() => getTripPdf(tripId, ctx), []); },
    },
    calendarSource: {
      // getName is part of the interface and was missing, so the calendar UI had no
      // label for this source and fell back to a generic one.
      getName() { return 'Flights'; },
      async getEvents(userId, start, end, ctx) { return attempt(() => getUserCalendar(userId, start, end, ctx), []); },
    },
  },

  // --- core event subscriptions (needs events:subscribe) ----------------------
  // USERLESS: ctx.trips / ctx.meta / ctx.notify / ctx.ws are all refused here, so
  // these handlers touch nothing but the plugin's own database. Fire-and-forget on
  // a ~5s timeout — a slow subscriber can never block or fail a core write, which
  // is why the age filters in the hooks above remain the real backstop.
  events: [
    {
      on: 'reservation:deleted',
      // Nothing used to remove a cache row when its reservation went away, so a
      // deleted flight kept printing in an exported PDF for 24h, kept plotting its
      // airports on the trip map for 6h, and — because cal_events is only ever
      // reconciled from an authenticated view of that same reservation — stayed in
      // the owner's TREK calendar indefinitely.
      async handler({ entityId }, ctx) {
        const rid = entityId != null ? String(entityId) : null;
        if (!rid) return;
        await tryLog(ctx, 'event.reservation-deleted', () => ctx.db.tx([
          { sql: 'DELETE FROM cache WHERE reservation_id = ?', args: [rid] },
          { sql: 'DELETE FROM legs WHERE reservation_id = ?', args: [rid] },
          { sql: 'DELETE FROM flights WHERE reservation_id = ?', args: [rid] },
          { sql: 'DELETE FROM cal_events WHERE rid = ?', args: [rid] },
          { sql: 'DELETE FROM notif_state WHERE rid = ?', args: [rid] },
        ]));
      },
    },
    {
      on: 'reservation:updated',
      // An edited flight number used to be masked by up to two hours of cached
      // schedule. Dropping the cache row makes the next open re-detect immediately;
      // the resolved legs go too, so the job stops chasing the old number.
      async handler({ entityId }, ctx) {
        const rid = entityId != null ? String(entityId) : null;
        if (!rid) return;
        await tryLog(ctx, 'event.reservation-updated', () => ctx.db.tx([
          { sql: 'DELETE FROM cache WHERE reservation_id = ?', args: [rid] },
          { sql: 'DELETE FROM legs WHERE reservation_id = ?', args: [rid] },
        ]));
      },
    },
    {
      on: 'trip:deleted',
      async handler({ tripId }, ctx) {
        const tid = tripId != null ? String(tripId) : null;
        if (!tid) return;
        await tryLog(ctx, 'event.trip-deleted', () => ctx.db.tx([
          { sql: 'DELETE FROM cache WHERE trip_id = ?', args: [tid] },
          { sql: 'DELETE FROM legs WHERE trip_id = ?', args: [tid] },
          { sql: 'DELETE FROM flights WHERE trip_id = ?', args: [tid] },
          { sql: 'DELETE FROM cal_events WHERE trip_id = ?', args: [tid] },
        ]));
      },
    },
  ],

  // --- background refresh (needs jobs:run) ------------------------------------
  // The plugin's oldest structural defect: every native surface it feeds — trip
  // warnings, map markers and layers, the day plan, the PDF, the calendar, the
  // table column, the dashboard badge — read a cache that was only ever written
  // when a human opened that exact reservation card. So the planner told you
  // nothing about a cancellation unless you had already gone looking for it.
  //
  // This job runs USERLESS. It cannot re-derive legs (that needs
  // ctx.trips.getReservations) and it cannot notify or broadcast, so it works
  // strictly from the resolved identifiers buildPayload persisted, and patches the
  // cached payload in place. Notifications still ride the authenticated routes —
  // but they now diff against data this job kept current.
  jobs: [
    {
      id: 'refresh-active',
      schedule: '*/15 * * * *',
      async handler(ctx) {
        // 1. Prune first: it costs nothing and it is the only thing standing between
        //    three insert-only tables and the 256 MB db:own ceiling, past which every
        //    write fails and the plugin silently stops caching entirely.
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        await tryLog(ctx, 'job.prune', () => ctx.db.tx([
          { sql: 'DELETE FROM cache WHERE fetched_at < ?', args: [cutoff] },
          { sql: 'DELETE FROM legs WHERE updated_at < ? AND (arr_ms IS NULL OR arr_ms < ?)', args: [cutoff, cutoff] },
          { sql: 'DELETE FROM cal_events WHERE updated_at < ?', args: [Date.now() - 180 * 24 * 3600 * 1000] },
          { sql: 'DELETE FROM quota WHERE (k LIKE ? OR k LIKE ? OR k LIKE ?) AND updated_at < ?', args: ['force:%', 'set:%', 'test:2%', Date.now() - 24 * 3600 * 1000] },
        ]));

        const key = await getKeyChecked(ctx);
        if (!key) return;                       // adsb.fi alone is not worth a cron tick
        if (!(await aeroAllowed(ctx))) {        // rejected key or month spent
          ctx.log.warn('background refresh skipped', { reason: (await keyInvalid(ctx)) ? 'key rejected' : 'monthly quota reached' });
          return;
        }
        // The job gets its own slice of the month. Without this, a couple of
        // long-haul flights refreshed on every tick would eat the whole budget and
        // every user's widget would read "monthly quota reached" — the background
        // convenience starving the thing a person is waiting on.
        const jobCeiling = Math.floor(AERO_MONTHLY_BUDGET * AERO_JOB_SHARE);
        if ((await quotaGet(ctx, monthKey())) >= jobCeiling) {
          ctx.log.warn('background refresh skipped', { reason: 'job share of the monthly budget is spent', ceiling: jobCeiling });
          return;
        }

        // 2. Only flights that are actually moving or about to: from 3h before
        //    departure to 2h after arrival, AND only those rested long enough since
        //    their last background refresh. The window alone is not a budget: a 10h
        //    flight sits in it for 15h, which at one refresh per tick is 60 requests
        //    for a single leg against a 550/month key. The rest interval is what
        //    turns that into a handful.
        //
        //    The EXISTS clause matters as much: the prune drops cache rows on a flat
        //    7-day cutoff while deliberately keeping legs for flights that have not
        //    departed, so a leg can outlive its payload. Refreshing one of those
        //    spends a request and then throws the answer away at the merge below,
        //    because there is nothing to merge it into.
        const now = Date.now(), H = 3600 * 1000;
        const rows = await attempt(() => ctx.db.query(
          'SELECT reservation_id, leg_index, trip_id, number, callsign, from_iata, to_iata, leg_date, dep_ms, arr_ms, last_refresh_at'
          + ' FROM legs WHERE number <> \'\' AND dep_ms IS NOT NULL AND dep_ms < ? AND (arr_ms IS NULL OR arr_ms > ?)'
          + ' AND EXISTS (SELECT 1 FROM cache WHERE cache.reservation_id = legs.reservation_id)'
          + ' ORDER BY dep_ms ASC LIMIT 24',
          now + 3 * H, now - 2 * H), []);
        if (!rows || !rows.length) return;

        // 3. Re-query sequentially and patch the cached payloads. Capped per tick so
        //    one very busy instance cannot spend the month in a single minute.
        const byReservation = new Map();
        let spent = 0;
        for (const row of rows) {
          if (spent >= 6) break;
          if (!(await aeroAllowed(ctx))) break;
          if ((await quotaGet(ctx, monthKey())) >= jobCeiling) break;
          // Refresh fast only where the data actually changes: close to departure or
          // already airborne. Everything else in the window rests much longer.
          const near = (row.dep_ms - now) < 1 * H;
          const interval = near ? JOB_INTERVAL_NEAR_MS : JOB_INTERVAL_FAR_MS;
          if (row.last_refresh_at && (now - Number(row.last_refresh_at)) < interval) continue;
          spent++;
          const leg = {
            number: row.number, callsign: row.callsign || '',
            from: row.from_iata || null, to: row.to_iata || null,
            depDayId: null, arrDayId: null, seat: null,
          };
          const tracked = await tryLog(ctx, 'job.trackLeg',
            () => trackLeg(ctx, leg, key, { status: true, live: true, date: row.leg_date || null }), null);
          // Record the attempt either way, so a leg that keeps failing does not get
          // retried every single tick.
          const st = tracked && tracked.status;
          const depU = toMs(st && st.departure && (st.departure.revisedUtc || st.departure.scheduledUtc));
          const arrU = toMs(st && st.arrival && (st.arrival.revisedUtc || st.arrival.scheduledUtc));
          await tryLog(ctx, 'job.legs-write', () => ctx.db.exec(
            'UPDATE legs SET last_refresh_at = ?, dep_ms = COALESCE(?, dep_ms), arr_ms = COALESCE(?, arr_ms)'
            + ' WHERE reservation_id = ? AND leg_index = ?',
            now, depU, arrU, String(row.reservation_id), Number(row.leg_index)));
          if (!tracked) continue;
          const list = byReservation.get(String(row.reservation_id)) || [];
          list.push({ index: Number(row.leg_index), tracked });
          byReservation.set(String(row.reservation_id), list);
        }

        // 4. Merge into the stored payload rather than rebuilding it: the parts the
        //    job cannot reproduce (day ids, seat, the detected airline, the booking
        //    type) live only in that payload and must survive untouched.
        for (const [rid, updates] of byReservation) {
          const cached = await attempt(() => ctx.db.query('SELECT payload, trip_id FROM cache WHERE reservation_id = ?', rid), []);
          if (!cached || !cached[0]) continue;
          let p; try { p = JSON.parse(cached[0].payload); } catch (_e) { continue; }
          if (!p || !Array.isArray(p.legs)) continue;
          let touched = false;
          for (const u of updates) {
            const target = p.legs[u.index];
            if (!target) continue;
            // NEVER let a transient failure erase what we already knew. trackLeg
            // returns status:null on a 429, a 5xx, a 7s timeout or simply no match
            // this tick — and the merge then wrote that null over a cached
            // 'Canceled', while stamping the row fresh. Every surface that reads the
            // cache skips a leg with no status, so a cancellation already visible in
            // the planner would quietly vanish for the whole freshness window.
            const merged = Object.assign({}, target, {
              live: u.tracked.live,
              weather: u.tracked.weather || target.weather,
              inbound: u.tracked.inbound,
              errors: u.tracked.errors,
              notes: u.tracked.notes,
            });
            if (u.tracked.status) merged.status = u.tracked.status;
            p.legs[u.index] = merged;
            touched = true;
          }
          if (!touched) continue;
          // Re-derive the booking window and phase from the refreshed statuses, so a
          // flight that has since landed stops being re-queried on the next tick.
          const first = p.legs[0], last = p.legs[p.legs.length - 1];
          const depU = toMs(first && first.status && first.status.departure && (first.status.departure.revisedUtc || first.status.departure.scheduledUtc));
          const arrU = toMs(last && last.status && last.status.arrival && (last.status.arrival.revisedUtc || last.status.arrival.scheduledUtc));
          p.booking = p.booking || {};
          if (depU != null) p.booking.depMs = depU;
          if (arrU != null) p.booking.arrMs = arrU;
          const d = p.booking.depMs, a = p.booking.arrMs;
          p.booking.phase = (d && now < d - 48 * H) ? 'upcoming' : ((a && now > a + 6 * H) ? 'past' : 'active');
          // Re-derive the TOP-LEVEL status fields too. They are what ttlFor reads,
          // and the job stamps the row fresh — so leaving a stale
          // 'monthly quota reached' in p.errors pinned the TTL at 6h for ever
          // (the job kept resetting fetched_at, so the backoff never expired) and
          // kept showing the user a banner about a quota that had since reset.
          const errs = [];
          p.legs.forEach((l) => (l.errors || []).forEach((e) => { if (e && errs.indexOf(e) === -1) errs.push(e); }));
          const notes = [];
          p.legs.forEach((l) => (l.notes || []).forEach((n) => { if (n && notes.indexOf(n) === -1) notes.push(n); }));
          p.errors = errs.slice(0, 4);
          p.notes = notes.slice(0, 4);
          p.keyInvalid = await keyInvalid(ctx);
          p.quotaRemaining = (await quotaGet(ctx, 'ada:remaining')) || null;
          p.updatedAt = Date.now();
          await tryLog(ctx, 'job.cache-write', () => ctx.db.exec(
            'INSERT OR REPLACE INTO cache (reservation_id, trip_id, payload, fetched_at) VALUES (?, ?, ?, ?)',
            rid, cached[0].trip_id, JSON.stringify(p), Date.now()));
        }
        ctx.log.info('background refresh done', { legs: spent, reservations: byReservation.size });
      },
    },
  ],

  // --- data rights (needs hook:user-data) -------------------------------------
  // The plugin stores two per-user tables — which flight numbers a user tracks, on
  // what dates, between which airports (cal_events) and the alert state derived
  // from them (notif_state). Neither was ever pruned and neither was reachable by
  // TREK's account export or erasure. Both handlers run USERLESS on own-db only.
  async deleteUserData({ userId }, ctx) {
    const uid = String(userId);
    await ctx.db.tx([
      { sql: 'DELETE FROM cal_events WHERE uid = ?', args: [uid] },
      { sql: 'DELETE FROM notif_state WHERE uid = ?', args: [uid] },
    ]);
    ctx.log.info('erased plugin data for user', { userId: uid });
  },

  async exportUserData({ userId }, ctx) {
    const uid = String(userId);
    const cal = await attempt(() => ctx.db.query('SELECT rid, trip_id, data, updated_at FROM cal_events WHERE uid = ?', uid), []);
    const notif = await attempt(() => ctx.db.query('SELECT rid, sig FROM notif_state WHERE uid = ?', uid), []);
    return {
      calendarEvents: (cal || []).map((r) => {
        let events = []; try { events = JSON.parse(r.data); } catch (_e) { events = []; }
        return { reservationId: r.rid, tripId: r.trip_id, updatedAt: r.updated_at, events: events };
      }),
      // Included for completeness: this is derived alert state, not travel data,
      // but it is keyed to the user and so belongs in their export.
      notificationState: (notif || []).map((r) => ({ reservationId: r.rid, lastKnownState: r.sig })),
    };
  },

  // --- settings-page actions ---------------------------------------------------
  // Runs USER-BOUND via POST /api/plugin-settings/<id>/action, so ctx.config is
  // available. The result is normalised to { ok, message }, message capped at 200.
  actions: {
    async test_key(ctx) {
      const key = await getKeyChecked(ctx);
      if (!key) return { ok: false, message: 'No AeroDataBox key is configured. Without one the widget still shows the live adsb.fi position, but no schedule, gate or delay.' };
      const before = await quotaGet(ctx, monthKey());
      if (before >= AERO_MONTHLY_BUDGET) {
        return { ok: false, message: 'This month\'s request budget (' + AERO_MONTHLY_BUDGET + ') is used up. Schedule lookups resume next month; the live position is unaffected.' };
      }
      // This button renders on EVERY user's settings page, not just an admin's, and
      // the key it spends is instance-wide. `actions` handlers get no request and no
      // user, so there is nothing to gate on — bound the damage instead: reuse a
      // recent answer, and cap how many real probes a day the button can ever cause.
      const dayKey = 'test:' + new Date().toISOString().slice(0, 10);
      const last = await quotaGet(ctx, 'test:last');
      if (last && (Date.now() - last) < TEST_KEY_CACHE_MS) {
        const okCached = (await quotaGet(ctx, 'test:ok')) === 1;
        return { ok: okCached, message: okCached
          ? 'Key works (checked a moment ago). Re-test in a few minutes for a fresh answer.'
          : 'The last check a moment ago failed. Re-test in a few minutes, or check the key in Admin -> Plugins.' };
      }
      if ((await quotaGet(ctx, dayKey)) >= TEST_KEY_PER_DAY) {
        return { ok: false, message: 'The key has been tested too many times today. It resets tomorrow; the last check is shown above.' };
      }
      // A rejected key is remembered so nothing keeps spending requests on it — but
      // this button is the one deliberate "check again" the user has, and a 403 is
      // usually a lapsed RapidAPI plan fixed upstream without the key ever changing.
      // Clear the flag first so the probe below is what actually decides; fetchAero
      // re-sets it if the key really is still rejected.
      await quotaSet(ctx, 'ada:invalid', 0);
      await quotaBump(ctx, dayKey, 1);
      await quotaSet(ctx, 'test:last', Date.now());
      // One real lookup against a busy, always-scheduled number. Spends exactly one
      // request, which is why the widget must never call this on render.
      const r = await fetchAero(ctx, 'LH400', key, null);
      await quotaSet(ctx, 'test:ok', r.error ? 0 : 1);
      if (r.error) return { ok: false, message: 'AeroDataBox rejected the request: ' + String(r.error).slice(0, 150) };
      const remaining = await quotaGet(ctx, 'ada:remaining');
      const used = await quotaGet(ctx, monthKey());
      return {
        ok: true,
        message: remaining
          ? 'Key works. ' + remaining + ' requests left on your RapidAPI plan.'
          : 'Key works. ' + used + ' of ' + AERO_MONTHLY_BUDGET + ' requests used this month.',
      };
    },
  },

  routes: [
    { method: 'GET', path: '/status', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (p.badId) return json(400, { error: 'tripId and reservationId must be numeric ids' });
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        const own = await requireOwnedReservation(ctx, p.tripId, p.reservationId);
        if (own.error) return own.error;
        const payload = await cachedPayload(ctx, p.tripId, String(p.reservationId), false, null, own.resv);
        // Run the diff even on a CACHE HIT. It used to be skipped, which was correct
        // when only this route ever wrote the cache — but the background job now
        // refreshes it, so the change a user most needs to hear about typically
        // lands in a cached payload. maybeNotify is idempotent (it dedups on its own
        // stored signature) and recordUserFlight is an upsert, so running both every
        // time is safe and is what makes the job's work reach the user.
        await tryLog(ctx, 'status.notify', () => maybeNotify(ctx, req.user, String(p.reservationId), payload, p.locale));
        await tryLog(ctx, 'status.record', () => recordUserFlight(ctx, req.user, p.tripId, String(p.reservationId), payload));
        payload.canSetKey = canSetKey(ctx, req.user); // per-request — never cached
        return json(200, payload);
      } },

    { method: 'POST', path: '/refresh', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (p.badId) return json(400, { error: 'tripId and reservationId must be numeric ids' });
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        const own = await requireOwnedReservation(ctx, p.tripId, p.reservationId);
        if (own.error) return own.error;
        const payload = await cachedPayload(ctx, p.tripId, String(p.reservationId), true, null, own.resv);
        await tryLog(ctx, 'refresh.notify', () => maybeNotify(ctx, req.user, String(p.reservationId), payload, p.locale));
        await tryLog(ctx, 'refresh.record', () => recordUserFlight(ctx, req.user, p.tripId, String(p.reservationId), payload));
        // Tell every other member's open card to re-fetch. Route-only (it needs the
        // acting user and their membership) and NAME-ONLY — the payload never
        // reaches the frame, so this is strictly a ping. The frames then read from
        // the cache we just wrote, so it costs no extra AeroDataBox requests.
        if (p.tripId && !payload.throttled) await broadcastUpdate(ctx, p.tripId);
        payload.canSetKey = canSetKey(ctx, req.user); // per-request — never cached
        return json(200, payload);
      } },

    // Manual single-flight override for a reservation (empty clears it).
    { method: 'POST', path: '/set', auth: true,
      async handler(req, ctx) {
        const p = readParams(req);
        if (p.badId) return json(400, { error: 'tripId and reservationId must be numeric ids' });
        if (!p.reservationId) return json(400, { error: 'reservationId required' });
        // Gate FIRST: this route writes the override table and, via ctx.meta, into
        // TREK's own reservation data.
        const own = await requireOwnedReservation(ctx, p.tripId, p.reservationId);
        if (own.error) return own.error;
        const rid = String(p.reservationId);
        const number = normNumber(p.flightNumber);
        if (number) {
          await ctx.db.exec('INSERT OR REPLACE INTO flights (reservation_id, trip_id, flight_number, updated_at) VALUES (?, ?, ?, ?)',
            rid, p.tripId != null ? String(p.tripId) : null, number, Date.now());
          // Best-effort mirror onto the reservation itself, so other TREK surfaces
          // can read the resolved number. It stays wrapped because ctx.meta can be
          // absent on an unversioned host — but the failure is now LOGGED: this call
          // also enforces reservation_edit, so a silent catch here is exactly how the
          // plugin's own store and TREK's meta drift apart with nothing to show for it.
          await tryLog(ctx, 'meta.set(flight_number)', () => ctx.meta.set('reservation', Number(rid), 'flight_number', number));
        } else {
          await ctx.db.exec('DELETE FROM flights WHERE reservation_id = ?', rid);
          await tryLog(ctx, 'meta.delete(flight_number)', () => ctx.meta.delete('reservation', Number(rid), 'flight_number'));
        }
        // The resolved legs describe the OLD number; drop them with the cache so the
        // background job cannot keep querying a flight the user just corrected.
        await tryLog(ctx, 'set.invalidate', () => ctx.db.tx([
          { sql: 'DELETE FROM cache WHERE reservation_id = ?', args: [rid] },
          { sql: 'DELETE FROM legs WHERE reservation_id = ?', args: [rid] },
        ]));
        // The override is saved above regardless. But the lookup that follows spends
        // an AeroDataBox request, and this route was the one path that skipped the
        // /refresh cooldown entirely (that guard is `force && !forcedNumber`, and a
        // manual number is exactly a forcedNumber). Any trip member could therefore
        // loop /set and drain the instance-wide month in seconds rather than the
        // minutes /refresh allows. Short window, because correcting a typo twice in
        // a row is legitimate; the next poll picks up the real data either way.
        const setKey = 'set:' + rid;
        const lastSet = await quotaGet(ctx, setKey);
        if (lastSet && (Date.now() - lastSet) < SET_COOLDOWN_MS) {
          return json(200, { applicable: true, source: number ? 'manual' : 'none', throttled: true,
            legs: [], booking: {}, canSetKey: canSetKey(ctx, req.user), updatedAt: Date.now() });
        }
        await quotaSet(ctx, setKey, Date.now());
        const payload = await cachedPayload(ctx, p.tripId, rid, true, number, own.resv);
        if (p.tripId) await broadcastUpdate(ctx, p.tripId);
        payload.canSetKey = canSetKey(ctx, req.user); // per-request — never cached
        return json(200, payload);
      } },

    // Instance-wide AeroDataBox key, settable in-widget by an admin (TREK >=3.4.0,
    // where req.user.isAdmin is reliable). An empty value clears it. Every cached
    // payload is dropped afterwards: entries built without a key hold no schedule
    // data, so they would otherwise mask the newly-working lookups until TTL.
    { method: 'POST', path: '/key', auth: true,
      async handler(req, ctx) {
        if (!canSetKey(ctx, req.user)) return json(403, { error: 'admin only' });
        // Body only. Fail loudly rather than silently ignoring a query-string key:
        // a caller who thinks the key was set would never rotate the leaked one.
        if (req.query && req.query.apiKey != null) return json(400, { error: 'apiKey must be sent in the JSON body, not the query string' });
        const b = (req.body && typeof req.body === 'object') ? req.body : {};
        const val = (b.apiKey == null ? '' : String(b.apiKey)).trim();
        if (val) await ctx.db.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('aerodatabox_key', ?)", val);
        else await ctx.db.exec("DELETE FROM kv WHERE k = 'aerodatabox_key'");
        // A new key deserves a clean slate: clear the sticky "rejected" flag and the
        // fingerprint it was set for, or a corrected key would stay disabled. Cached
        // payloads go too — entries built without a key hold no schedule data and
        // would otherwise mask the newly-working lookups until their TTL expired.
        await tryLog(ctx, 'key.reset', () => ctx.db.tx([
          { sql: 'DELETE FROM cache', args: [] },
          { sql: "DELETE FROM quota WHERE k IN ('ada:invalid', 'ada:invalid_for', 'ada:remaining')", args: [] },
        ]));
        return json(200, { ok: true, hasKey: !!val });
      } },
  ],
});
