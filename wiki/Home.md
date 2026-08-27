# Flight Tracker

Turns every flight reservation in TREK into a live flight tracker. The widget sits
under the reservation card and combines scheduled data from **AeroDataBox** with
the actual aircraft position from the free **adsb.fi** open-data network.

![Flight Tracker, en route](https://raw.githubusercontent.com/fbnlrz/trek-track/main/docs/img/widget-enroute.png)

| | |
|---|---|
| **[Setup](Setup)** | Install, activate, add the AeroDataBox key |
| **[Troubleshooting](Troubleshooting)** | Something isn't showing? Start here |
| **[How it works](How-it-works)** | Data sources, quota, caching, privacy |
| **[Development](Development)** | Build the airline dataset, run the tests |

## What it shows

**In the air** — altitude, ground speed, registration and aircraft type, a great-circle
map with the flown part solid and the rest dashed, plus percent flown, time remaining
and distance to go. The map is a bundled inline vector, so it works inside TREK's
strict plugin sandbox with no external tiles.

**On the ground** — terminal, gate, baggage belt, your seat, a boarding-time estimate,
and an "aircraft inbound" read-out that tells you where the tail assigned to your
flight is right now.

**When things go wrong** — departure *and* arrival delay, cancellation and diversion,
gate changes. Delayed or cancelled flights also surface as native trip warnings in the
planner and as a badge on the trip card on your dashboard, and you get a deduplicated
bell/email notification while TREK is open. Since 2.0.0 each user decides under
**Settings → Plugins → Flight Tracker** whether to receive those alerts at all, and
from how many minutes of delay.

Requires **TREK 4.0.0 or newer**. The range `>=4.0.0 <5.0.0` is enforced at install and
re-checked at activation, with no admin override, so TREK 3.x instances stay on
**1.8.0** — the store resolves "install latest" to the newest version an instance can
run, and refuses an update that would take a working plugin out of compatibility.

## The widget in different states

| Pre-flight | Multi-leg with a tight connection |
|---|---|
| ![Pre-flight](https://raw.githubusercontent.com/fbnlrz/trek-track/main/docs/img/widget-preflight.png) | ![Multi-leg](https://raw.githubusercontent.com/fbnlrz/trek-track/main/docs/img/widget-multileg.png) |
| Terminal, gate, seat, boarding time and the inbound aircraft. | A journey header, a layover connector between legs, and a warning when the connection is tight. |

| Without an API key | Narrow sidebar (320 px) |
|---|---|
| ![No key](https://raw.githubusercontent.com/fbnlrz/trek-track/main/docs/img/widget-keyless.png) | ![Narrow](https://raw.githubusercontent.com/fbnlrz/trek-track/main/docs/img/widget-narrow.png) |
| The live position from adsb.fi needs no key at all. Schedule, gate and delay do. | Everything reflows; the label rail is preserved rather than stacked. |

Light and dark theme are both supported and follow TREK's own tokens — every
screenshot above also exists as a `-light` variant in
[`docs/img/`](https://github.com/fbnlrz/trek-track/tree/main/docs/img).

## Other TREK surfaces it feeds

Beyond the widget, your flights appear on the **trip map** (airports, the live aircraft
and the great-circle route line between the two airports), in the **day plan** with
their block time counted into the day's travel total, as a live status column in the
**reservations table**, in the **trip PDF export** (date, flight, route, terminal/gate,
belt, seat, status), in the **TREK calendar** with live-adjusted times, as a badge on
the **trip card** on your dashboard, and as native **trip warnings** when something is
delayed or cancelled.

A background job keeps all of those current for flights that are in the air or close to
departure, so they are right even when nobody has the widget open, and reservation
edits and deletions are picked up as they happen rather than hours later.

## Links

- [Issues](https://github.com/fbnlrz/trek-track/issues) · [Releases](https://github.com/fbnlrz/trek-track/releases)
- Data: [AeroDataBox](https://aerodatabox.com/) · [adsb.fi](https://adsb.fi/) (personal, non-commercial use)
- Licence: MIT
