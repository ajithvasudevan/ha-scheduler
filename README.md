# Schedules — a daily on/off scheduler for Home Assistant

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

### HACS (custom repository)

1. HACS → ⋮ → **Custom repositories**.
2. Repository: this repository's URL. Type: **Integration**. Add.
3. Install **Schedules (TSVK Scheduler)**, then restart Home Assistant.
4. Settings → Devices & services → **Add integration** → *Schedules*.

### Manually

1. Copy `custom_components/tsvk_scheduler/` into your `config/custom_components/`.
2. Restart Home Assistant.
3. Settings → Devices & services → **Add integration** → *Schedules*.

**Schedules** then appears in the sidebar. Nothing else to configure.

> Set up with `tsvk_scheduler:` in `configuration.yaml` before? That still works: the
> key is imported into a config entry on the next start, and you can delete the line.

### Requirements

Home Assistant **2024.7** or newer, with `default_config` (or at least the `config`,
`frontend`, `http`, `lovelace`, `schedule` and `automation` integrations).

---

## How it works

Three moving parts, all of them ordinary Home Assistant objects you can inspect:

| Part | What it is | Where it lives |
|---|---|---|
| Timing | One `schedule.*` helper per rule | Settings → Devices & services → Helpers |
| Mapping and switching | One generated automation, `automation.tsvk_scheduler_engine` | `automations.yaml` |
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
* the `tsvk_scheduler_apply` event, which is what **Restore now** fires.

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
copy to a hidden dashboard (`tsvk-schedules-data`) that they can.

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
`TSVK Scheduler` on first use and stores its refresh token in `.storage`. Nothing leaves
the machine, and no human user's token is ever read.

---

## Services

| Service | What it does |
|---|---|
| `tsvk_scheduler.save_rule` | Create or update a rule (name, targets, windows, enabled). |
| `tsvk_scheduler.delete_rule` | Remove a rule and its helper. Devices keep their current state. |
| `tsvk_scheduler.set_enabled` | Pause or resume a rule without losing its times. |
| `tsvk_scheduler.apply` | Re-assert every scheduled device to what its schedule says now. |

`apply` is worth a look on its own: call it from an automation after a power cut, a
guest leaving, or any other "put everything back" moment.

```yaml
action: tsvk_scheduler.apply
```

---

## Uninstalling

1. Settings → Devices & services → *Schedules* → delete the entry. The sidebar panel and
   the services go away; your rules do not.
2. To remove the rules too: delete `automation.tsvk_scheduler_engine`, the
   `schedule.*` helpers it names, and the hidden `tsvk-schedules-data` dashboard.
3. Delete the `TSVK Scheduler` system user under Settings → People if you want it gone.

---

## Development

`custom_components/tsvk_scheduler/frontend/tsvk-scheduler-panel.js` is a copy; the
frontend is developed in `../panel` alongside its test suite. `./sync.sh` copies both in
and runs everything.

```bash
./tests/run.sh     # compileall, node --check, the panel suite, the Python tests
```

Before publishing, point `documentation` and `issue_tracker` in
`custom_components/tsvk_scheduler/manifest.json` at wherever this repository actually
lives — they currently hold placeholder URLs — and add yourself to `codeowners`.

`tests/test_engine.py` includes a **parity** check: it runs the panel's `buildEngine()`
under Node and asserts it produces the same automation as `engine.py`. Both sides write
that file, so they must not drift. Keep them in step, and keep the window maths
identical between `engine.py` and the JavaScript.
