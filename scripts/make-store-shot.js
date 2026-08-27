#!/usr/bin/env node
// Renders docs/screenshot.png — the 1600x900 store image the TREK plugin registry
// shows on the plugin's tile and detail page. It is a HARD registry gate: the entry
// is rejected if the URL does not resolve to a real image at the pinned commit.
//
//   npm run store-shot            # needs Chrome/Edge + `npm i`
//
// Same approach as make-screenshots.js and for the same reason: no dev server and
// no Playwright. The widget is inlined into an `srcdoc` iframe with a fake
// `window.trek`, so this runs anywhere Chrome exists.
//
// This page is the HOST, not the plugin frame, so it is not under the plugin CSP
// and may use gradients and patterns freely. It draws card chrome for presentation;
// the real widget renders chrome-free inside TREK's own card.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'docs', 'screenshot.png');
const TMP = path.join(os.tmpdir(), 'ft-store-shot');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

function findChrome() {
  const cands = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return cands.find((c) => { try { return fs.existsSync(c); } catch (e) { return false; } }) || null;
}
const CHROME = findChrome();
if (!CHROME) { console.log('SKIP: no Chrome/Edge found (set CHROME_PATH).'); process.exit(0); }

let kit;
try { kit = require('trek-plugin-sdk'); if (!kit.TREK_UI_CSS) throw new Error('no TREK_UI_CSS'); }
catch (e) { console.log('SKIP: trek-plugin-sdk unavailable (run `npm i`) — ' + e.message); process.exit(0); }

const widget = fs.readFileSync(path.join(REPO, 'client', 'index.html'), 'utf8');
const MARKER = kit.TREK_UI_MARKER || '<!-- trek:ui -->';

// --- the composition ---------------------------------------------------------
const CONFIG = {
  accent: '#8b5cf6',                 // the plugin's established violet
  accent2: '#38bdf8',                // sky blue — the aviation half of the pairing
  kicker: 'TREK PLUGIN',
  name: 'Flight Tracker',
  tagline: 'Live status, gates and delays for every flight booking — plus the aircraft '
    + 'on a built-in minimap, and the great-circle route on TREK\'s own trip map.',
  pills: ['Live position + route', 'Trip map, day plan, PDF', 'Status column + dashboard badge', 'Multi-leg + alerts'],
  frameWidth: 430,
  frameHeight: 545,
};

// --- fixture: one en-route long-haul, delayed ---------------------------------
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');

const LEG = {
  number: 'SQ304', callsign: 'SIA304', airline: 'Singapore Airlines', from: 'SIN', to: 'LHR', seat: '45E',
  status: {
    number: 'SQ304', status: 'EnRoute', airline: 'Singapore Airlines',
    aircraftModel: 'Airbus A350-900', aircraftReg: '9V-SMG', delayMin: -43, depDelayMin: 0,
    departure: { iata: 'SIN', name: 'Changi', terminal: '3', gate: 'B8',
      scheduled: iso(now - 5 * 3600e3), revised: null, scheduledUtc: iso(now - 5 * 3600e3), revisedUtc: null,
      lat: 1.36, lon: 103.99 },
    arrival: { iata: 'LHR', name: 'Heathrow', terminal: '2', gate: 'A12', baggageBelt: '7',
      scheduled: iso(now + 6 * 3600e3), revised: iso(now + 6 * 3600e3 - 43 * 60e3),
      scheduledUtc: iso(now + 6 * 3600e3), revisedUtc: iso(now + 6 * 3600e3 - 43 * 60e3),
      lat: 51.47, lon: -0.45 },
  },
  live: { hex: '76cdb1', callSign: 'SIA304', reg: '9V-SMG', type: 'A359', desc: 'AIRBUS A350-900',
    lat: 26.836, lon: 73.5, altBaro: 38000, groundSpeed: 512, track: 305, verticalRate: 0, onGround: false, seenPos: 2 },
  weather: { temp: 19, main: 'Clouds', description: 'Overcast', tempMax: 21, tempMin: 13, precipProb: 20 },
  inbound: null, errors: [],
};

const PAYLOAD = {
  applicable: true, source: 'detected', hasKey: true, canSetKey: false,
  legs: [LEG],
  booking: { type: 'flight', depMs: now - 5 * 3600e3, arrMs: now + 6 * 3600e3, phase: 'active',
    origin: 'SIN', dest: 'LHR', legCount: 1 },
  errors: [], updatedAt: now,
};

// The widget mounts in the reservation-detail slot, so the context MUST carry a
// reservationId — without one it collapses itself to a 1px sliver and the shot is
// an empty card.
function widgetDoc(theme) {
  const bridge = `
<style>${kit.TREK_UI_CSS}</style>
<style>html,body{margin:0;background:transparent}</style>
<script>
(function(){
  var P = ${JSON.stringify(PAYLOAD)};
  window.trek = {
    onContext: function (cb) { setTimeout(function(){ cb({ tripId:1, reservationId:42, userId:7,
      theme:'${theme}', locale:'en-GB', dir:'ltr',
      formats:{locale:'en-GB',timezone:'Europe/London',hour12:false,distanceUnit:'metric'},
      appearance:{scheme:'default',density:'comfortable',reducedMotion:false,noTransparency:false},
      viewport:{surface:'detail-slot',formFactor:'desktop',fill:false,insets:{top:0,bottom:0}},
      tokens:{} }); },0); },
    invoke: function(){ return Promise.resolve(JSON.parse(JSON.stringify(P))); },
    notify: function(){}, navigate: function(){}, openExternal: function(){},
    confirm: function(){ return Promise.resolve(true); }, onEvent: function(){}, resize: function(){},
  };
})();
<\/script>`;
  return widget.replace(MARKER, bridge);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Store shot</title>
<style>
  :root { --accent:${CONFIG.accent}; --accent2:${CONFIG.accent2};
          --font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
          --fg:#f4f4f5; --fg-muted:#a1a1aa; }
  * { box-sizing: border-box; }
  html, body { margin:0; width:1600px; height:900px; overflow:hidden; font-family:var(--font);
               background:#0a0a0f; color:var(--fg); }
  /* Accent glow toward the top-left, so the centre stays calm and the cards stay focal. */
  .glow { position:absolute; inset:0;
          background:
            radial-gradient(900px 620px at 12% -8%, color-mix(in srgb, var(--accent) 55%, transparent), transparent 70%),
            radial-gradient(760px 520px at 88% 108%, color-mix(in srgb, var(--accent2) 26%, transparent), transparent 70%); }
  /* A faint wave texture, so the background is not a flat gradient. */
  .pat { position:absolute; inset:0; opacity:.05;
         background-image: repeating-linear-gradient(115deg, #fff 0 1px, transparent 1px 14px); }
  /* The whole composition must fit 1600x900 with nothing clipped — the registry
     also crops this to 16:10 for the discover card, so keep the cards centred. */
  .wrap { position:relative; height:100%; display:flex; flex-direction:column;
          padding:40px 90px 0; gap:14px; }
  .kicker { font-size:14px; font-weight:700; letter-spacing:.22em; text-transform:uppercase;
            color:color-mix(in srgb, var(--accent) 55%, #fff); }
  h1 { margin:4px 0 0; font-size:54px; line-height:1.02; letter-spacing:-.028em; font-weight:800; }
  .tagline { margin:0; max-width:66ch; font-size:17px; line-height:1.45; color:var(--fg-muted); }
  .pills { display:flex; gap:9px; flex-wrap:wrap; }
  .pill { border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.05);
          border-radius:999px; padding:6px 14px; font-size:13px; color:#d4d4d8; white-space:nowrap; }
  .cards { display:flex; gap:26px; justify-content:center; align-items:flex-start;
           margin-top:4px; }
  .col { display:flex; flex-direction:column; align-items:center; gap:7px; }
  /* Presentation chrome only — the real widget is chrome-free inside TREK's card. */
  .card { width:${CONFIG.frameWidth}px; border-radius:16px; overflow:hidden;
          box-shadow:0 26px 70px rgba(0,0,0,.5); }
  .card.light { background:#fff; border:1px solid rgba(0,0,0,.07); }
  .card.dark  { background:#131316; border:1px solid rgba(255,255,255,.08); }
  .head { font-size:11px; font-weight:700; letter-spacing:.11em; text-transform:uppercase;
          padding:12px 16px 0; }
  .card.light .head { color:#6b7280; } .card.dark .head { color:#a1a1aa; }
  iframe { width:100%; height:${CONFIG.frameHeight}px; border:0; display:block; }
  .badge { font-size:11.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--fg-muted); }
</style></head><body>
<div class="glow"></div><div class="pat"></div>
<div class="wrap">
  <div>
    <div class="kicker">${esc(CONFIG.kicker)}</div>
    <h1>${esc(CONFIG.name)}</h1>
  </div>
  <p class="tagline">${esc(CONFIG.tagline)}</p>
  <div class="pills">${CONFIG.pills.map((p) => '<span class="pill">' + esc(p) + '</span>').join('')}</div>
  <div class="cards">
    <div class="col">
      <div class="card light"><div class="head">${esc(CONFIG.name)}</div>
        <iframe srcdoc="${esc(widgetDoc('light'))}"></iframe></div>
      <div class="badge">light</div>
    </div>
    <div class="col">
      <div class="card dark"><div class="head">${esc(CONFIG.name)}</div>
        <iframe srcdoc="${esc(widgetDoc('dark'))}"></iframe></div>
      <div class="badge">dark</div>
    </div>
  </div>
</div>
</body></html>`;

const file = path.join(TMP, 'store-shot.html');
fs.writeFileSync(file, page);

execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--virtual-time-budget=6000', '--window-size=1600,900',
  '--screenshot=' + OUT, 'file:///' + file.replace(/\\/g, '/')],
{ stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });

const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log('  docs/screenshot.png  1600x900  ' + kb + ' KB');
