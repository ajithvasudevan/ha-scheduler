"""The service implementations behind the Schedules panel.

Security boundary
-----------------
The services take a *structured, validated* rule — id, name, target entity ids,
windows — and this module builds the engine automation itself. It deliberately does
**not** accept a caller-supplied automation body: that would let any logged-in user
write arbitrary actions (`shell_command`, `python_script`, …) and have Home Assistant
run them. Targets are restricted to switchable domains, windows to sane integers, and
the only three objects ever written are the engine automation, the `schedule.*` helpers
named in the model, and the read-only mirror dashboard.
"""

from __future__ import annotations

import logging
import secrets
from datetime import timedelta

import homeassistant.util.dt as dt_util
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ServiceValidationError

from .api import SelfApi
from .const import (
    APPLY_EVENT,
    ENGINE_ID,
    MIRROR_NOTE,
    MIRROR_PATH,
    MIRROR_TITLE,
)
from .engine import build_engine, days_payload, has_edges, has_solar, is_solar

_LOGGER = logging.getLogger(__name__)


class Scheduler:
    """Reads and writes the rule set on behalf of callers who may not be admins."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.api = SelfApi(hass)

    # ------------------------------------------------------------------ model

    async def async_model(self) -> dict:
        try:
            cfg = await self.api.async_rest("GET", f"config/automation/config/{ENGINE_ID}")
        except RuntimeError:
            cfg = None
        model = (cfg or {}).get("variables", {}).get("hs_cfg") or {"v": 1, "rules": []}
        if not isinstance(model.get("rules"), list):
            model["rules"] = []
        return model

    async def async_commit(self, model: dict) -> None:
        await self.api.async_rest(
            "POST", f"config/automation/config/{ENGINE_ID}", build_engine(model)
        )
        await self.hass.services.async_call("automation", "reload", {}, blocking=True)
        # Apply straight away so a new rule takes effect now, not at its next edge.
        self.hass.bus.async_fire(APPLY_EVENT)
        try:
            await self.async_save_mirror(model)
        except Exception as err:  # noqa: BLE001 - a stale mirror must not fail a save
            _LOGGER.warning("Could not refresh the read-only mirror: %s", err)

    # ----------------------------------------------------------------- mirror

    async def async_save_mirror(self, model: dict) -> None:
        """Publish the model where non-admins can read it, creating the hidden
        dashboard that holds it the first time round."""
        config = {
            "views": [
                {
                    "title": "data",
                    "cards": [{"type": "markdown", "content": MIRROR_NOTE, "model": model}],
                }
            ]
        }
        save = {"type": "lovelace/config/save", "url_path": MIRROR_PATH, "config": config}
        try:
            await self.api.async_ws([save])
        except RuntimeError:
            await self.api.async_ws(
                [
                    {
                        "type": "lovelace/dashboards/create",
                        "url_path": MIRROR_PATH,
                        "title": MIRROR_TITLE,
                        "icon": "mdi:database",
                        "show_in_sidebar": False,
                        "require_admin": False,
                    },
                    save,
                ]
            )

    # --------------------------------------------------------- solar apply

    def _solar_side_minutes(self, v: object) -> int | None:
        """Resolve a window side to minutes-past-midnight for today.

        Returns None if v is None (one-way side) or if sun.sun is unavailable.
        """
        if v is None:
            return None
        if not is_solar(v):
            return int(v)  # type: ignore[arg-type]
        sun = self.hass.states.get("sun.sun")
        if not sun:
            return None
        attr = "next_rising" if v["sun"] == "sunrise" else "next_setting"  # type: ignore[index]
        raw = sun.attributes.get(attr)
        if not raw:
            return None
        dt = dt_util.parse_datetime(raw)
        if dt is None:
            return None
        dt_local = dt_util.as_local(dt)
        now_date = dt_util.now().date()
        # next_rising/next_setting is the next future occurrence. If it's tomorrow, subtract
        # one day to get the time that already happened (or will happen) today.
        if dt_local.date() != now_date:
            dt_local = dt_local - timedelta(days=1)
        return dt_local.hour * 60 + dt_local.minute + int(v.get("offset", 0))  # type: ignore[index]

    async def async_apply_solar_rule(self, rule: dict) -> None:
        """Assert the current on/off state for a solar rule based on today's sun times.

        Called immediately after saving or re-enabling a solar rule so the device
        reflects the schedule without waiting for the next sunrise/sunset trigger.
        Skips silently if sun.sun is unavailable (e.g., HA still starting up).
        """
        targets = rule.get("targets") or []
        if not targets:
            return
        if self.hass.states.get("sun.sun") is None:
            _LOGGER.debug("sun.sun unavailable — skipping immediate solar apply for %s", rule.get("id"))
            return

        now_min = dt_util.now().hour * 60 + dt_util.now().minute
        should_be_on = False
        for w in rule.get("windows") or []:
            s = self._solar_side_minutes(w.get("s"))
            e = self._solar_side_minutes(w.get("e"))
            if s is None or e is None:
                continue  # unresolvable or one-way — skip this window
            if s == 0 and e == 0:
                should_be_on = True  # all-day window
                break
            in_window = (now_min >= s and now_min < e) if e > s else (now_min >= s or now_min < e)
            if in_window:
                should_be_on = True
                break

        action = "turn_on" if should_be_on else "turn_off"
        _LOGGER.debug("Solar apply for %s: %s (now=%d)", rule.get("id"), action, now_min)
        await self.hass.services.async_call(
            "homeassistant", action, {"entity_id": targets}, blocking=True
        )

    # --------------------------------------------------------------- services

    @staticmethod
    def _new_rule_id(model: dict, wanted: str | None) -> str:
        used = {r.get("id") for r in model["rules"]}
        if wanted and wanted not in used:
            return wanted
        while True:
            candidate = f"r{secrets.token_hex(4)}"
            if candidate not in used:
                return candidate

    async def async_save_rule(self, call: ServiceCall) -> dict:
        model = await self.async_model()
        rule_id = call.data.get("rule_id")
        name = call.data["name"].strip()
        targets = list(call.data["targets"])
        windows = [{"s": w["s"], "e": w["e"]} for w in call.data["windows"]]
        enabled = call.data["enabled"]

        rule = next((r for r in model["rules"] if r.get("id") == rule_id), None) if rule_id else None
        days = days_payload(windows)
        # Rules with one-way (null) sides or solar times cannot use a schedule helper:
        # schedule helpers only understand fixed HH:MM times. These rules fire only at
        # their named moments; state is not restored at boot.
        no_helper = has_edges(windows) or has_solar(windows)

        if no_helper:
            if rule is not None and rule.get("schedule"):
                try:
                    await self.api.async_ws(
                        [{"type": "schedule/delete", "schedule_id": rule["schedule"].split(".")[1]}]
                    )
                except RuntimeError as err:
                    _LOGGER.warning("Schedule helper already gone for %s: %s", rule_id, err)
                rule["schedule"] = None
            if rule is None:
                rule = {
                    "id": self._new_rule_id(model, rule_id),
                    "name": name,
                    "schedule": None,
                    "targets": [],
                    "windows": [],
                    "enabled": True,
                }
                model["rules"].append(rule)
        elif rule is None or not rule.get("schedule"):
            created = (
                await self.api.async_ws(
                    [{"type": "schedule/create", "name": name, "icon": "mdi:calendar-clock", **days}]
                )
            )[0]
            if rule is not None:
                rule["schedule"] = f"schedule.{created['id']}"
            else:
                rule = {
                    "id": self._new_rule_id(model, rule_id),
                    "name": name,
                    "schedule": f"schedule.{created['id']}",
                    "targets": [],
                    "windows": [],
                    "enabled": True,
                }
                model["rules"].append(rule)
        else:
            await self.api.async_ws(
                [
                    {
                        "type": "schedule/update",
                        "schedule_id": rule["schedule"].split(".")[1],
                        "name": name,
                        "icon": "mdi:calendar-clock",
                        **days,
                    }
                ]
            )

        rule["name"] = name
        rule["targets"] = targets
        rule["windows"] = windows
        rule["enabled"] = enabled
        # One device belongs to exactly one rule, so the engine map is never ambiguous.
        for other in model["rules"]:
            if other is not rule:
                other["targets"] = [t for t in other.get("targets", []) if t not in targets]

        await self.async_commit(model)
        if enabled and has_solar(windows):
            await self.async_apply_solar_rule(rule)
        return {"rule_id": rule["id"], "schedule": rule["schedule"]}

    async def async_delete_rule(self, call: ServiceCall) -> dict:
        model = await self.async_model()
        rule_id = call.data["rule_id"]
        rule = next((r for r in model["rules"] if r.get("id") == rule_id), None)
        if rule is None:
            raise ServiceValidationError(f"No such schedule rule: {rule_id}")
        if rule.get("schedule"):
            try:
                await self.api.async_ws(
                    [{"type": "schedule/delete", "schedule_id": rule["schedule"].split(".")[1]}]
                )
            except RuntimeError as err:
                _LOGGER.warning("Schedule helper already gone for %s: %s", rule_id, err)
        model["rules"] = [r for r in model["rules"] if r.get("id") != rule_id]
        # Devices are deliberately left in whatever state they are in.
        await self.async_commit(model)
        return {"deleted": rule_id}

    async def async_set_enabled(self, call: ServiceCall) -> dict:
        model = await self.async_model()
        rule = next((r for r in model["rules"] if r.get("id") == call.data["rule_id"]), None)
        if rule is None:
            raise ServiceValidationError(f"No such schedule rule: {call.data['rule_id']}")
        rule["enabled"] = call.data["enabled"]
        await self.async_commit(model)
        if rule["enabled"] and has_solar(rule.get("windows")):
            await self.async_apply_solar_rule(rule)
        return {"rule_id": rule["id"], "enabled": rule["enabled"]}

    async def async_apply_all_solar_rules(self) -> None:
        """Restore current on/off state for every enabled solar rule.

        Called once at boot (after a delay so sun.sun is populated) and after a
        ha_scheduler.apply service call, so solar rules behave like state rules on
        restart rather than waiting until the next sunrise/sunset trigger fires.
        """
        try:
            model = await self.async_model()
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Boot solar restore: could not load model: %s", err)
            return
        for rule in model.get("rules", []):
            if rule.get("enabled", True) is not False and has_solar(rule.get("windows")):
                try:
                    await self.async_apply_solar_rule(rule)
                except Exception as err:  # noqa: BLE001
                    _LOGGER.warning("Boot solar restore failed for %s: %s", rule.get("id"), err)

    async def async_apply(self, _call: ServiceCall) -> None:
        self.hass.bus.async_fire(APPLY_EVENT)
        await self.async_apply_all_solar_rules()
