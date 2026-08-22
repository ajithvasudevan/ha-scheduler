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
from .engine import build_engine, days_payload

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
        model = (cfg or {}).get("variables", {}).get("tsvk_cfg") or {"v": 1, "rules": []}
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

    # --------------------------------------------------------------- services

    async def async_save_rule(self, call: ServiceCall) -> dict:
        model = await self.async_model()
        rule_id = call.data.get("rule_id")
        name = call.data["name"].strip()
        targets = list(call.data["targets"])
        windows = [{"s": w["s"], "e": w["e"]} for w in call.data["windows"]]
        enabled = call.data["enabled"]

        rule = next((r for r in model["rules"] if r.get("id") == rule_id), None) if rule_id else None
        days = days_payload(windows)

        if rule is None or not rule.get("schedule"):
            created = (
                await self.api.async_ws(
                    [{"type": "schedule/create", "name": name, "icon": "mdi:calendar-clock", **days}]
                )
            )[0]
            used = {r.get("id") for r in model["rules"]}
            new_id = rule_id if rule_id and rule_id not in used else None
            while new_id is None:
                candidate = f"r{secrets.token_hex(4)}"
                if candidate not in used:
                    new_id = candidate
            rule = {
                "id": new_id,
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
        return {"rule_id": rule["id"], "enabled": rule["enabled"]}

    async def async_apply(self, _call: ServiceCall) -> None:
        self.hass.bus.async_fire(APPLY_EVENT)
