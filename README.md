# Flight Tracker

Turn every flight reservation in TREK into a live flight tracker. The widget sits
under each reservation card in the trip planner and shows the real-time status of that
flight — combining scheduled data from **AeroDataBox** with the actual aircraft
position from the free **adsb.fi** open-data network.

Requires **TREK 4.0.0 or newer** (`>=4.0.0 <5.0.0`). TREK checks that range at install
*and* again at activation, and there is no admin override — so on a TREK 3.x instance
the store keeps serving **1.8.0**, which stays the supported build there. "Install
latest" resolves to the newest version an instance can actually run, and an update that
would push a working plugin out of its range is refused rather than performed.

📖 **[Full documentation in the wiki](https://github.com/fbnlrz/trek-track/wiki)** —
[Setup](https://github.com/fbnlrz/trek-track/wiki/Setup) ·
[Troubleshooting](https://github.com/fbnlrz/trek-track/wiki/Troubleshooting) ·
[How it works](https://github.com/fbnlrz/trek-track/wiki/How-it-works) ·
[Development](https://github.com/fbnlrz/trek-track/wiki/Development)

![Flight Tracker, en route](./docs/img/widget-enroute.png)

## Setup

1. **Admin → Plugins** — install and activate the plugin, then approve its permissions.
   2.0.0 requests eight permissions 1.8.0 did not, so **updating needs re-approval**
   before it runs again.
2. Open a trip and expand a flight reservation. The tracker appears beneath it. The
   flight number is detected from the booking; if not, type it once and it is
   remembered. The **live adsb.fi position works with no key**.
3. **Add the AeroDataBox key** to unlock schedule, terminal, gate, belt and delay. Get
   a free key at `rapidapi.com/aedbx-aedbx/api/aerodatabox`, then — **as a TREK
   administrator** — open any flight reservation and use **“Add AeroDataBox key”**
   under the tracker.

The key is **instance-wide**: one admin sets it once and everyone benefits. Once a key
is active the field disappears, since it is a set-once setting. Non-admins never see
it. There is also an admin config API for scripted setup, and it takes precedence over
the in-widget key. The plugin's settings page carries a **“Test AeroDataBox key”**
button: it makes one AeroDataBox call and reports whether the key is accepted and how
many requests are left this month.

Every user then has two settings of their own under **Settings → Plugins → Flight
Tracker**: **`notify_enabled`** (on/off, default on) turns the bell/email alerts off
for you alone, and **`delay_threshold_min`** (default 15) sets the delay from which you
want to hear about it. The threshold also governs when a delay is raised as a trip
warning. Before 2.0.0 the thresholds were hardcoded and the only way to stop the alerts
was for an admin to remove the instance-wide API key, which disabled the plugin for
everybody.

> **Full setup, including how to change or remove a key, why TREK renders no settings
> form for the instance key, and what to do when RapidAPI says “You are not subscribed
> to this API”** — see **[Setup](https://github.com/fbnlrz/trek-track/wiki/Setup)** and
> **[Troubleshooting](https://github.com/fbnlrz/trek-track/wiki/Troubleshooting)**.

## What it does

- **Reads the flight straight from the booking.** It builds the flight number from the
  reservation's airline + flight-number fields (e.g. `Austrian Airlines` + `254` →
  `OS254`), using a bundled database of ~2,800 airline name spellings.
- **Forgiving about how you type it.** `Frontier Airlines` + `1234`, `F9 1234`,
  `F91234` and the ICAO form `FFT1234` all resolve to the same flight, and airline
  names match loosely — `Delta Airlines`, `Delta Air Lines` and `Delta` are all
  understood. Airline codes containing a digit (`F9`, `U2`, `6E`, `W6`) are ~40 % of
  all codes and are parsed correctly. Codes are checked against a build-time probe
  list, so a stale upstream entry can't silently point a lookup at the wrong carrier.
- **Multi-leg flights.** Connections get a total-route header, per-leg tracking, the
  layover duration and a tight-connection warning. Long itineraries collapse completed
  legs.
- **Schedule & status** (AeroDataBox): departure/arrival airports, scheduled vs.
  revised times, **departure and arrival delay**, live status, plus terminal, gate and
  baggage belt.
- **Live position in the air** (adsb.fi): altitude, ground speed, climb/descent trend,
  registration and type, a progress read-out, and a **built-in minimap** drawing the
  great-circle route — flown part solid, remaining dashed, aircraft rotated to its
  heading. No external map tiles, so it works inside TREK's strict plugin sandbox. A
  position older than 5 minutes is marked stale rather than drawn as if live.
- **Before departure:** a boarding-time estimate, an **inbound-aircraft** read-out
  (“your plane is on its way, ~40 min out”), and the arrival time in your own timezone.
- **Native TREK integration:** flights also appear on the **trip map** — airports, the
  live aircraft, and the **great-circle route line** drawn between them, flown part
  solid and the rest dashed — in the **day plan** with their block time counted into
  the day's travel total, as a live **status column** in the reservations table, in the
  **trip PDF export** (date, route, terminal/gate, belt, seat, status), and in the
  **TREK calendar** with live-adjusted times.
- **A badge on your dashboard.** A delayed or cancelled flight marks the trip card on
  the dashboard — the one surface that reaches you before you open the trip at all.
- **Change alerts.** Delays, cancellations, diversions and gate changes surface as
  native trip warnings and — while you have TREK open — as a deduplicated bell/email
  notification in your own language. Each user chooses whether to get them at all and
  from how many minutes of delay.
- **Fresh without you.** A background job refreshes flights that are in the air or
  close to departure, so the warnings, map, PDF, calendar, table column and dashboard
  badge are right even when nobody has the widget open. Edits and deletions of a
  reservation are picked up as they happen, and when one trip member refreshes or
  corrects a flight, every other member's open card updates straight away.
- **Quota-aware.** The free AeroDataBox tier is ~600 requests/month, so the refresh
  interval follows time-to-departure, polling pauses when the tab is hidden, forced
  refreshes are rate-limited per reservation, and once the monthly ceiling is reached
  the plugin falls back to adsb.fi alone rather than failing.
- **Answers a data-subject request.** The per-user notification and calendar rows it
  stores go into your TREK account export and are removed when the account is deleted.
- **Stays out of the way** on non-flight reservations, and works in light and dark
  theme, German and English.

## Screenshots

| Pre-flight | Multi-leg, tight connection |
|---|---|
| ![Pre-flight](./docs/img/widget-preflight.png) | ![Multi-leg](./docs/img/widget-multileg.png) |

| Without an API key | Narrow sidebar (320 px) |
|---|---|
| ![No key](./docs/img/widget-keyless.png) | ![Narrow](./docs/img/widget-narrow.png) |

Every shot also exists as a `-light` variant in [`docs/img/`](./docs/img). Regenerate
them with `npm run screenshots`.

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Stores the flight number linked to each reservation and a short-lived response cache in the plugin's own SQLite database. |
| `db:read:trips` | Reads the reservation to auto-detect its flight number — and is the membership check that authorises every request. |
| `db:meta` | Best-effort mirror of the chosen flight number onto the reservation so other TREK surfaces can read it. |
| `notify:send` | Sends a bell/email notification to you (only) when a tracked flight's delay, gate or status changes. |
| `weather:read` | Shows the destination weather for the arrival day (host-cached forecast broker). |
| `jobs:run` | Runs the background refresh for flights that are in the air or close to departure, so the trip warnings, map, PDF, calendar, table column and dashboard badge are right even when nobody has opened the widget. It also prunes old rows. |
| `events:subscribe` | Reacts to reservation edits and deletions, so a deleted flight leaves the map, the PDF and your calendar immediately instead of lingering there for hours, and an edited flight number is re-detected the next time the card is opened. |
| `ws:broadcast:trip` | When one trip member refreshes or corrects a flight, every other member's open card updates immediately instead of waiting for its next poll. |
| `hook:trip-warning-provider` | Shows delayed/cancelled flights as native trip warnings in the planner. |
| `hook:map-marker-provider` | Plots your flights' airports and live aircraft on TREK's own trip map. |
| `hook:map-layer-provider` | Draws the great-circle route between the departure and arrival airports on that same trip map, with the flown part solid and the remainder dashed. |
| `hook:day-schedule-provider` | Adds each flight to its day in the plan with its block time, so the day's total travel time includes the flight. |
| `hook:table-contributor` | Adds a live flight-status column to the reservations table. |
| `hook:trip-card-provider` | Puts a delay or cancellation badge on the trip card on your dashboard — the only surface that reaches you before you open the trip. |
| `hook:pdf-section-provider` | Adds a flights section to the exported trip PDF. |
| `hook:calendar-source` | Puts your flights (with live-adjusted times) into TREK's calendar. |
| `hook:user-data` | Implements TREK's data-rights hook, so the per-user notification and calendar rows this plugin stores are included in an account export and removed when the account is deleted. |
| `http:outbound` | Marks the plugin as making outbound HTTP calls. |
| `http:outbound:aerodatabox.p.rapidapi.com` | Fetches flight schedule, status, gate and delay data from AeroDataBox. |
| `http:outbound:opendata.adsb.fi` | Fetches the live aircraft position from the adsb.fi open-data API. |

The booking reference (PNR) is deliberately not included in the widget payload.

Data sources: [AeroDataBox](https://aerodatabox.com/) and [adsb.fi](https://adsb.fi/) —
adsb.fi open data is for personal, non-commercial use.

The bundled airline database (`server/data/airlines.json`) is generated by
`npm run build:airlines` from
[Virtual Radar Server standing-data](https://github.com/vradarserver/standing-data)
(CC0, pinned to a commit) merged with
[OpenFlights](https://github.com/jpatokal/openflights) (ODbL), plus the hand-verified
fixes in `server/data/airline-overrides.json`.

## Development

```bash
npm install
npm run build:airlines   # regenerate the airline dataset (fails on a probe mismatch)
npm run screenshots      # regenerate docs/img/*
./node_modules/.bin/trek-plugin validate .
```

Building against TREK 4 needs **`trek-plugin-sdk` 1.6.0 or newer**: 1.5.0's permission
list predates TREK 4, so it does not know `hook:map-layer-provider` or
`hook:day-schedule-provider` and rejects the manifest outright. Run the locally
installed binary rather than `npx -y trek-plugin-sdk`, which resolves to 1.5.0.

See **[Development](https://github.com/fbnlrz/trek-track/wiki/Development)** for the
release process, the override policy for airline codes, and the platform gotchas worth
knowing before changing anything.

## License

MIT — see `LICENSE`.

---

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20me-FF00FF?logo=kofi&logoColor=white)](https://ko-fi.com/fbnlrz) [![Buy Me A Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-Japan%202027-00FFFF?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/fbnlrz)
