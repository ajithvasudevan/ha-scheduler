# Schedules — HA Scheduler

A Home Assistant custom integration that adds a full-screen **Schedules** panel to your sidebar. It replaces the Simple Scheduler add-on with a native HA integration that handles fixed-time, one-way (edge), and **sunrise/sunset ± offset** schedule rules.

---

## Features

- **Full-screen panel** — dedicated sidebar entry ("Schedules", `mdi:calendar-clock`)
- **Fixed-time windows** — HH:MM start/end with midnight-wrap support
- **Solar windows** — start or end at Sunrise/Sunset ± offset in minutes; tooltip shows the raw solar time on hover
- **One-way (edge) rules** — "turn on only" or "turn off only" at a specific time
- **All-day rules** — device stays on all day
- **Pause/resume** — disable a rule without losing its times
- **Boot restore** — all rule types (fixed, solar) assert correct state 45 s after HA restart
- **Non-admin support** — read-only panel for non-admins; write via `ha_scheduler.*` services
- **Unsaved-changes guard** — Cancel and Escape prompt to discard or keep editing

---

## Requirements

- Home Assistant 2024.1.0 or newer
- The built-in `schedule` integration (enabled automatically via dependencies)

---

## Installation

### HACS (recommended)

1. In HACS → Integrations → ⋮ → **Custom repositories**
2. Add `https://github.com/ajithvasudevan/ha-scheduler` with category **Integration**
3. Install **Schedules**
4. Restart Home Assistant
5. Go to **Settings → Devices & Services → Add Integration** and search for **Schedules**

### Manual

1. Download or clone this repository
2. Copy the `ha_scheduler` folder into your `config/custom_components/` directory:
   ```
   config/
   └── custom_components/
       └── ha_scheduler/
           ├── __init__.py
           ├── api.py
           ├── config_flow.py
           ├── const.py
           ├── engine.py
           ├── manifest.json
           ├── scheduler.py
           ├── services.yaml
           ├── strings.json
           ├── translations/
           └── frontend/
               └── ha-scheduler-panel.js
   ```
3. Restart Home Assistant
4. Go to **Settings → Devices & Services → Add Integration** and search for **Schedules**

---

## Usage

After setup, **Schedules** appears in the HA sidebar. Click **+ New** to create a rule:

1. **Pick a device** — switch, light, input_boolean, fan, siren, valve, humidifier, or automation
2. **Add time windows** — each window has a start and end time
   - Click the **☀** icon next to any time to switch it to Sunrise/Sunset ± minutes
   - Leave one side blank (`--`) for a one-way rule
3. **Save** — the rule takes effect immediately

### Schedule types

| Type | How it works |
|---|---|
| Fixed-time | Backed by a `schedule.*` helper; correct state restored on HA restart |
| Solar | Fires at sunrise/sunset each day; state restored on restart via `sun.sun` |
| One-way (edge) | Fires only at the listed moment; no state restoration between events |

---

## Services

| Service | Description |
|---|---|
| `ha_scheduler.save_rule` | Create or update a rule |
| `ha_scheduler.delete_rule` | Delete a rule |
| `ha_scheduler.set_enabled` | Pause or resume a rule |
| `ha_scheduler.apply` | Re-assert all scheduled states right now |

---

## How it works

All rule data is stored in `variables.hs_cfg` inside a single generated automation (`automation.ha_scheduler_engine`). Fixed-time rules additionally get a `schedule.*` helper whose state is a pure function of the wall clock, ensuring correct restoration after restarts. Solar rules are restored 45 s post-boot by the integration reading today's `sun.sun` attributes.

---

## License

MIT
