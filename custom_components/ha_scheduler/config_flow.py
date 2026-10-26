"""Single-instance config flow. There is nothing to configure — the flow exists so the
integration can be added from the UI and reloaded like any other."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN, PANEL_TITLE


class HaSchedulerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the (empty) set-up dialog."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is None:
            return self.async_show_form(step_id="user")
        return self.async_create_entry(title=PANEL_TITLE, data={})

    async def async_step_import(self, import_data: dict[str, Any]) -> ConfigFlowResult:
        """Adopt an instance that was set up with `ha_scheduler:` in YAML."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title=PANEL_TITLE, data={})
