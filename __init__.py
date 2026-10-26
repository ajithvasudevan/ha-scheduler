"""Schedules — a daily on/off scheduler with its own full-screen panel.

What this integration does
--------------------------
* Serves the panel's JavaScript from inside the integration and registers it as a
  sidebar panel, so there is nothing to copy into `/config/www` and no Lovelace
  resource to add by hand.
* Exposes the schedule operations as services. Home Assistant refuses non-admins
  `schedule/create|update|delete`, `/api/config/*` and `POST /api/events/*`; services
  are callable by them and run with hass privileges, so the panel falls back to these
  when `hass.user.is_admin` is false.

Model of operation
------------------
Timing truth lives in built-in `schedule.*` helpers, whose state is a pure function of
the wall clock — after a restart they report the correct on/off for *right now* rather
than replaying missed edges. The schedule -> target mapping lives in the `variables`
block of one generated automation, which is therefore the single persistent store.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry, SOURCE_IMPORT
from homeassistant.const import EVENT_HOMEASSISTANT_START
from homeassistant.core import HomeAssistant, SupportsResponse
from homeassistant.components import frontend
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .const import (
    ALLOWED_DOMAINS,
    DOMAIN,
    ENGINE_ID,
    FRONTEND_URL_BASE,
    PANEL_ELEMENT,
    PANEL_FILENAME,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
)
from .scheduler import Scheduler

_LOGGER = logging.getLogger(__name__)

# `ha_scheduler:` with nothing under it parses as None, which a plain dict schema
# rejects; this helper is what Home Assistant provides for a key that takes no options.
CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)

SERVICES = ("save_rule", "delete_rule", "set_enabled", "apply")
_STATIC_REGISTERED = f"{DOMAIN}_static_registered"


# ------------------------------------------------------------- service schemas
# The panel is the usual caller, but these are public services: validate as if the
# call came from an untrusted script, because it can.


def _target(entity_id: str) -> str:
    entity_id = cv.entity_id(entity_id)
    if entity_id.split(".")[0] not in ALLOWED_DOMAINS:
        raise vol.Invalid(f"{entity_id} is not a schedulable entity")
    if entity_id == f"automation.{ENGINE_ID}":
        raise vol.Invalid("the scheduler engine cannot schedule itself")
    return entity_id


# A side may be: null (one-way), an integer 0-1439 (fixed minutes), or a solar dict.
_SOLAR_SIDE = vol.Schema({
    vol.Required("sun"): vol.In(["sunrise", "sunset"]),
    vol.Optional("offset", default=0): vol.All(vol.Coerce(int), vol.Range(min=-480, max=480)),
})
_TIME_SIDE = vol.Any(
    None,
    vol.All(vol.Coerce(int), vol.Range(min=0, max=1439)),
    _SOLAR_SIDE,
)


def _window(value: Any) -> dict:
    window = vol.Schema({vol.Required("s"): _TIME_SIDE, vol.Required("e"): _TIME_SIDE})(value)
    if window["s"] is None and window["e"] is None:
        raise vol.Invalid("a window needs a start time, an end time, or both")
    return window


WINDOW_SCHEMA = _window

SAVE_SCHEMA = vol.Schema(
    {
        vol.Optional("rule_id"): vol.All(cv.string, vol.Length(min=1, max=64)),
        vol.Required("name"): vol.All(cv.string, vol.Length(min=1, max=80)),
        vol.Required("targets"): vol.All(cv.ensure_list, [_target], vol.Length(min=1, max=25)),
        vol.Required("windows"): vol.All(cv.ensure_list, [WINDOW_SCHEMA], vol.Length(min=1, max=24)),
        vol.Optional("enabled", default=True): cv.boolean,
    }
)

RULE_ID_SCHEMA = vol.Schema({vol.Required("rule_id"): vol.All(cv.string, vol.Length(min=1, max=64))})
ENABLED_SCHEMA = RULE_ID_SCHEMA.extend({vol.Required("enabled"): cv.boolean})


# --------------------------------------------------------------------- set-up


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Accept `ha_scheduler:` in configuration.yaml by importing it once.

    Everything real happens in async_setup_entry; the YAML key exists so instances set
    up before the config flow keep working after an upgrade.
    """
    if DOMAIN in config:
        hass.async_create_task(
            hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_IMPORT}, data={})
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Serve the panel, register it in the sidebar, and expose the services."""
    scheduler = Scheduler(hass)
    hass.data[DOMAIN] = scheduler

    await _async_register_frontend(hass)

    hass.services.async_register(
        DOMAIN, "save_rule", scheduler.async_save_rule, schema=SAVE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, "delete_rule", scheduler.async_delete_rule, schema=RULE_ID_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, "set_enabled", scheduler.async_set_enabled, schema=ENABLED_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(DOMAIN, "apply", scheduler.async_apply, schema=vol.Schema({}))

    # Restore solar rule states on every startup.  We wait 45 s — slightly after the
    # engine automation's own 40 s boot delay — so sun.sun is guaranteed to be ready.
    async def _solar_boot_restore_task() -> None:
        await asyncio.sleep(45)
        await scheduler.async_apply_all_solar_rules()

    if hass.is_running:
        # Integration was reloaded while HA is already up; apply immediately.
        hass.async_create_task(scheduler.async_apply_all_solar_rules())
    else:
        hass.bus.async_listen_once(
            EVENT_HOMEASSISTANT_START,
            lambda _event: hass.async_create_task(_solar_boot_restore_task()),
        )

    return True


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Publish the panel's module and put it in the sidebar.

    The module is served with caching switched off: a cached copy of a panel is
    indistinguishable from the integration not having updated, and the file is small.
    The version query string additionally changes on every release.
    """
    if not hass.data.get(_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    FRONTEND_URL_BASE,
                    str(Path(__file__).parent / "frontend"),
                    cache_headers=False,
                )
            ]
        )
        hass.data[_STATIC_REGISTERED] = True

    integration = await async_get_integration(hass, DOMAIN)
    module_url = f"{FRONTEND_URL_BASE}/{PANEL_FILENAME}?v={integration.version}"

    # Reloading the entry re-registers the panel, and registering a path twice is an
    # error, so drop any existing one first.
    _async_remove_panel(hass)

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        module_url=module_url,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        # Non-admins get a read-only view of the same screen; the panel decides what
        # they may press, and Home Assistant enforces it regardless.
        require_admin=False,
        embed_iframe=False,
        trust_external=False,
    )


def _async_remove_panel(hass: HomeAssistant) -> None:
    """Drop the sidebar panel if it is registered, quietly if it is not."""
    try:
        frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    except TypeError:      # warn_if_unknown predates some supported versions
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
    except Exception:      # noqa: BLE001 - never block unload on a missing panel
        pass


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the sidebar panel and the services. Rules and helpers are left alone."""
    _async_remove_panel(hass)
    for service in SERVICES:
        hass.services.async_remove(DOMAIN, service)
    hass.data.pop(DOMAIN, None)
    return True
