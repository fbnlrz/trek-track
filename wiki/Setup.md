# Setup

Requires **TREK 4.0.0 or newer**. The manifest declares `>=4.0.0 <5.0.0`; TREK enforces
that at install and re-checks it at activation, and an admin cannot override it.

On a **TREK 3.x instance the supported build is 1.8.0** and the store keeps serving it:
"install latest" resolves to the newest version the instance can actually run, and an
update that would take a working plugin out of its compatibility range is refused
rather than performed. Nothing needs doing to stay on 1.8.0 — upgrade TREK to 4.x when
you want 2.0.0.

(1.8.0 in turn needed 3.4.0, because below 3.4 a plugin is never told whether the
caller is an admin — [TREK#1569](https://github.com/liketrek/TREK/issues/1569) — so the
in-widget key entry cannot be gated safely.)

## 1. Install and activate

1. **Admin → Plugins**, install the plugin (upload `plugin.zip` or install from the
   registry), then **activate** it and approve its permissions.
2. Open a trip and expand a flight reservation. The tracker appears beneath it.

The flight number is detected from the booking's airline and flight-number fields. If
detection fails, type it once with the pencil icon and it is remembered for that
reservation. The **live position from adsb.fi works with no key at all**.

## 2. Add the AeroDataBox key

The key unlocks schedule, terminal, gate, baggage belt and delay. It is
**instance-wide**: one admin sets it once and every user on the instance benefits.

Get a free key at [rapidapi.com/aedbx-aedbx/api/aerodatabox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox).
The free tier is roughly **600 requests per month** — see
[How it works](How-it-works#quota) for how the plugin budgets that.

### In the widget (recommended)

Open any flight reservation **as a TREK administrator**. Under the tracker you will
see **"Add AeroDataBox key"** — click, paste, save.

![Key entry](https://raw.githubusercontent.com/fbnlrz/trek-track/main/docs/img/widget-key-entry.png)

Once a key is active the field **disappears**. That is deliberate: it is a set-once
setting, and repeating "key active · Replace · Remove" on every flight reservation is
noise. To change it later see [Changing or removing the key](#changing-or-removing-the-key).

Non-admins never see the field — only a note that an admin can add a key. The gate is
enforced on the **server** (`req.user.isAdmin` is re-checked on every request), so a
non-admin gets `403` even if the UI is tampered with.

### Via the admin config API

Useful for scripted or headless setup. As a **TREK administrator**, in dev tools
(**F12**) → **Console**:

```js
await fetch('/api/admin/plugins/flight-tracker/config', {
  method: 'PUT', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ aerodatabox_key: 'YOUR_RAPIDAPI_KEY' })
}).then(r => r.json()).then(console.log);
```

A masked response like `{ config: { aerodatabox_key: '••••••••' } }` means it saved.
Then **deactivate → activate** the plugin (config is only read at activation) and
hard-refresh the trip tab (**Ctrl/Cmd+Shift+R**).

> **There is no settings form for this key.** TREK renders a settings form only for
> `scope: "user"` plugin settings; this key is `scope: "instance"`, which has no form
> anywhere in the UI. The list under Admin → Plugins is read-only and informational.
> `plugins.service.ts` filters the settings-field query to `scope = 'user'`, and the
> admin panel renders `manifest.settings` without inputs. That is also why the plugin's
> two per-user settings *do* get a form — see
> [Your own notification settings](#4-your-own-notification-settings).

### Test the key

The plugin's settings page has a **"Test AeroDataBox key"** button. It makes one
AeroDataBox call with the key currently in effect and reports two things: whether the
key is accepted, and **how many requests are left this month**. Before 2.0.0 the plugin
had no way to show you the remaining quota at all — the only signal was data quietly
going missing once the ceiling was hit.

The test spends one request of your monthly allowance, so use it when something looks
wrong rather than as a habit.

## Which key wins

`ctx.config.aerodatabox_key` (the admin config API) is checked **first**. The key
stored by the in-widget field is used only when that is empty.

This matters more than it sounds: **if an old key sits in `ctx.config`, a new key
entered in the widget is ignored.** That is the single most common setup problem —
see [Troubleshooting](Troubleshooting#you-are-not-subscribed-to-this-api).

## Changing or removing the key

The two paths are **not** interchangeable — use the one matching how the key was set:

| Key was set… | Clear it with |
|---|---|
| via the admin config API | `PUT /api/admin/plugins/flight-tracker/config` with `{ aerodatabox_key: '' }`, then deactivate → activate |
| in the widget | the plugin's own route, below |

```js
// clears a key entered in the widget (the config API does NOT clear this one)
await fetch('/api/plugins/flight-tracker/key', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey: '' })          // or a new key to replace it
}).then(r => r.json()).then(console.log);
```

`{ ok: true, hasKey: false }` means it cleared, and "Add AeroDataBox key" reappears
for admins. The route is admin-only and answers `403` for anyone else. Note it only
accepts the key in the **JSON body** — a key in the query string is refused with
`400`, so it cannot end up in proxy logs or browser history.

Setting or clearing the key drops the response cache, so data updates immediately.

## 3. Verify it works

Open a flight departing in the next day or two. You should see the route, scheduled
versus revised times, and — once within about 48 h of departure — terminal and gate.

If something is missing, the widget now tells you why: API errors are rendered under
the card instead of failing silently. Head to [Troubleshooting](Troubleshooting).

## 4. Your own notification settings

Each user has two settings of their own under **Settings → Plugins → Flight Tracker**.
They are per-user, so changing them affects nobody else:

| Setting | Default | |
|---|---|---|
| `notify_enabled` | On | Bell and email alerts for delays, gate changes, cancellations and diversions on your own flights. Set it to **Off** to stop them for yourself. |
| `delay_threshold_min` | 15 | The delay, in minutes, from which you want to hear about it. Shorter delays are neither notified nor raised as a **trip warning**. |

The threshold governs the trip warning as well as the notification, so raising it is
also how you stop small delays cluttering the planner.

Before 2.0.0 the thresholds were hardcoded and there was no per-user switch: the only
way to stop the alerts was for an admin to remove the instance-wide API key, which
disabled schedule, gate and delay data for **everybody** on the instance.
