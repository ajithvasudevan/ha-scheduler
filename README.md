# Schedules — a daily on/off scheduler for Home Assistant

[![hacs: custom repository](https://img.shields.io/badge/HACS-custom%20repository-41BDF5.svg?style=flat-square)](https://hacs.xyz/docs/faq/custom_repositories/)
[![Home Assistant 2024.7+](https://img.shields.io/badge/Home%20Assistant-2024.7%2B-41BDF5.svg?style=flat-square&logo=home-assistant&logoColor=white)](https://www.home-assistant.io/)
[![release](https://img.shields.io/github/v/release/ajithvasudevan/ha-scheduler?style=flat-square&color=41BDF5)](https://github.com/ajithvasudevan/ha-scheduler/releases)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg?style=flat-square)](LICENSE)

A full-screen **Schedules** panel in the sidebar. Pick a device, give it on and off
times, and it repeats every day — through restarts, and without replaying missed edges.

* One screen for everything: create, edit, pause, delete, and see at a glance what is
  on now and what changes next.
* **Restore now** puts every scheduled device back to what its schedule says, for when
  someone has flipped a switch by hand.
* Overlapping on-times are drawn as written, never silently merged.
* Non-admin users can view every schedule, and edit them too — see
  [Who can change what](#who-can-change-what).

Everything is served by the integration itself: no files to copy into `/config/www`,
no Lovelace resource to add, no dashboard to build.

---

## Installing

This is not in the HACS default store, so HACS has to be pointed at it once. That is
what "custom repository" means below — after that it updates like anything else.

### HACS

[![Open your Home Assistant instance and open this repository inside HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=ajithvasudevan&repository=ha-scheduler&category=integration)

That button adds the repository and opens it. Then **Download**, and restart Home
Assistant.

Prefer to do it by hand:

1. **HACS** → **⋮** (top right) → **Custom repositories**.
2. Repository: `https://github.com/ajithvasudevan/ha-scheduler` — Type: **Integration**
   → **Add**.
3. Search HACS for **Schedules**, open it, **Download**.
4. Restart Home Assistant.

### Manually, without HACS

1. Copy `custom_components/ha_scheduler/` into your `config/custom_components/`, so you
   end up with `config/custom_components/ha_scheduler/manifest.json`.
2. Restart Home Assistant.

### Then, either way

[![Open your Home Assistant instance and start setting up a new integration.](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=ha_scheduler)

Or: **Settings → Devices & services → Add integration → Schedules**. There is nothing
to fill in — confirm the dialog and **Schedules** appears in the sidebar.

> Prefer YAML? `ha_scheduler:` on its own line in `configuration.yaml` is imported into
> a config entry on the next start, and the line can then be deleted.

### Updating

HACS offers the update; take it and restart. The panel is served by the integration
with caching switched off, so there is no browser cache to clear and no Lovelace
resource to re-version — a page reload is enough.

### Requirements

Home Assistant **2024.7** or newer, with `default_config` (or at least the `config`,
`frontend`, `http`, `lovelace`, `schedule` and `automation` integrations).

---

## How it works

Three moving parts, all of them ordinary Home Assistant objects you can inspect:

| Part | What it is | Where it lives |
|---|---|---|
| Timing | One `schedule.*` helper per rule | Settings → Devices & services → Helpers |
| Mapping and switching | One generated automation, `automation.ha_scheduler_engine` | `automations.yaml` |
| The rule set | The `variables:` block of that same automation | `automations.yaml` |

**Why schedule helpers hold the timing.** Their state is a pure function of the wall
clock. After a restart — or a five-hour power cut — they immediately report the correct
on/off for *right now*, so nothing has to be replayed or caught up.

**Why one automation.** It is the mapping from schedule to devices *and* the persistent
store for the panel's model, so there is exactly one file to back up and one object to
delete if you ever want the integration gone. It reacts to:

* a schedule edge (`for: 3s`, which swallows the microsecond blip a wrapping window
  produces at midnight),
* Home Assistant starting (after a 40 s grace period, so integrations can bring their
  entities up first),
* a device returning from `unavailable` — a device or network outage ending,
* the `ha_scheduler_apply` event, which is what **Restore now** fires.

Between those moments nothing is re-asserted, which is deliberate: **a manual override
lasts until the next scheduled change**. Flip a light on at 21:00 under a 22:00–05:00
schedule and it stays on; at 22:00 the schedule takes over again.

**Overlaps.** The panel keeps every window exactly as you entered it and draws overlaps
as a darker band. Home Assistant rejects overlapping blocks in a schedule helper, so the
union is what gets written there — the device experiences the same thing either way.

**Days.** Every rule is written to all seven days identically. There is no day-of-week
concept in the UI, by design.

---

## Who can change what

Home Assistant refuses non-admin users three things this panel needs: the
`schedule/create|update|delete` WebSocket commands, `/api/config/*`, and
`POST /api/events/*`. Services, however, are callable by any logged-in user and run with
Home Assistant's privileges rather than the caller's.

So the panel writes through the services in this integration when the viewer is not an
admin, and non-admins get the full editor. Reading is solved separately: the model lives
in an automation, which non-admins cannot read, so every save also publishes a read-only
copy to a hidden dashboard (`schedules-data`) that they can.

If you would rather non-admins only *look*, remove this integration's services from
their reach with a Home Assistant permission policy, or set the panel to admins only in
`const.py` (`PANEL_URL_PATH` is registered with `require_admin=False`).

**The security boundary is in the service schemas.** They take a structured rule — name,
target entity ids, windows — and build the automation here. A caller-supplied automation
body is never accepted; that would let any logged-in user run `shell_command` as Home
Assistant. Targets are restricted to `switch`, `light`, `input_boolean`, `fan`, `siren`,
`valve`, `humidifier` and `automation`.

**The system user.** The `schedule` integration keeps its storage collection in a local
variable, unreachable from a custom component, so this integration drives Home
Assistant's own API on `127.0.0.1` instead. It mints one admin *system* user named
`HA Scheduler` on first use and stores its refresh token in `.storage`. Nothing leaves
the machine, and no human user's token is ever read.

---

## Services

| Service | What it does |
|---|---|
| `ha_scheduler.save_rule` | Create or update a rule (name, targets, windows, enabled). |
| `ha_scheduler.delete_rule` | Remove a rule and its helper. Devices keep their current state. |
| `ha_scheduler.set_enabled` | Pause or resume a rule without losing its times. |
| `ha_scheduler.apply` | Re-assert every scheduled device to what its schedule says now. |

`apply` is worth a look on its own: call it from an automation after a power cut, a
guest leaving, or any other "put everything back" moment.

```yaml
action: ha_scheduler.apply
```

---

## Uninstalling

1. Settings → Devices & services → *Schedules* → delete the entry. The sidebar panel and
   the services go away; your rules do not.
2. To remove the rules too: delete `automation.ha_scheduler_engine`, the
   `schedule.*` helpers it names, and the hidden `schedules-data` dashboard.
3. Delete the `HA Scheduler` system user under Settings → People if you want it gone.

---

## Development

`custom_components/ha_scheduler/frontend/ha-scheduler-panel.js` is a copy; the frontend
is developed in [ha-scheduler-panel](https://github.com/ajithvasudevan/ha-scheduler-panel),
checked out next to this repository as `../panel`. `./sync.sh` copies the panel and its
suite in, then runs everything.

```bash
./tests/run.sh     # compileall, node --check, the panel suite, the Python tests
```

`tests/test_engine.py` includes a **parity** check: it runs the panel's `buildEngine()`
under Node and asserts it produces the same automation as `engine.py`. Both sides write
that file, so they must not drift. Keep them in step, and keep the window maths
identical between `engine.py` and the JavaScript.
