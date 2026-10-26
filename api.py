"""Talks to this Home Assistant over its own public API as a system admin user.

Why not call the internals? `schedule`'s storage collection is a local variable inside
its `async_setup` — it is never placed in `hass.data`, so there is no supported way to
reach it from a custom component. The public HTTP/WebSocket API is the part that does
not move between releases, so this drives that instead, over 127.0.0.1.

The credential is a refresh token for a dedicated *system* user this integration mints
once and stores. No user token is ever read, and nothing leaves the machine.
"""

from __future__ import annotations

import inspect
import json
import logging
from typing import Any

from homeassistant.auth.const import GROUP_ID_ADMIN
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION, SYSTEM_USER_NAME

_LOGGER = logging.getLogger(__name__)


async def _maybe_await(value: Any) -> Any:
    """Home Assistant's auth manager has been turning coroutines into plain calls one
    release at a time — `async_get_refresh_token` is awaitable on 2026.5 and not on
    2026.8. Accept either, so one copy of this integration works on both."""
    return await value if inspect.isawaitable(value) else value


class SelfApi:
    """Minimal REST + WebSocket client pointed at the instance it runs inside."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._token: str | None = None

    @property
    def _base(self) -> str:
        scheme = "https" if getattr(self.hass.http, "ssl_certificate", None) else "http"
        return f"{scheme}://127.0.0.1:{self.hass.http.server_port}"

    async def async_token(self) -> str:
        if self._token:
            return self._token
        data = await self._store.async_load() or {}
        refresh = None
        if token_id := data.get("refresh_token_id"):
            refresh = await _maybe_await(self.hass.auth.async_get_refresh_token(token_id))
        if refresh is None:
            user = None
            for candidate in await _maybe_await(self.hass.auth.async_get_users()):
                if candidate.name == SYSTEM_USER_NAME and candidate.system_generated:
                    user = candidate
                    break
            if user is None:
                user = await _maybe_await(
                    self.hass.auth.async_create_system_user(
                        SYSTEM_USER_NAME, group_ids=[GROUP_ID_ADMIN]
                    )
                )
            refresh = await _maybe_await(self.hass.auth.async_create_refresh_token(user))
            await self._store.async_save({"refresh_token_id": refresh.id})
            _LOGGER.info("Created the %s system user and refresh token", SYSTEM_USER_NAME)
        self._token = self.hass.auth.async_create_access_token(refresh)
        return self._token

    async def async_rest(self, method: str, path: str, body: Any = None) -> Any:
        token = await self.async_token()
        session = async_get_clientsession(self.hass)
        async with session.request(
            method,
            f"{self._base}/api/{path}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=body,
            timeout=30,
        ) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(f"{method} {path} -> {resp.status} {text[:200]}")
            return json.loads(text) if text.strip() else None

    async def async_ws(self, commands: list[dict]) -> list[Any]:
        """Run a batch of WebSocket commands on one connection, in order."""
        token = await self.async_token()
        session = async_get_clientsession(self.hass)
        results: list[Any] = []
        async with session.ws_connect(f"{self._base}/api/websocket", timeout=30) as ws:
            msg = await ws.receive_json()
            if msg.get("type") != "auth_required":
                raise RuntimeError(f"unexpected greeting: {msg}")
            await ws.send_json({"type": "auth", "access_token": token})
            msg = await ws.receive_json()
            if msg.get("type") != "auth_ok":
                raise RuntimeError(f"auth failed: {msg}")
            for index, command in enumerate(commands, start=1):
                await ws.send_json({**command, "id": index})
                while True:
                    msg = await ws.receive_json()
                    if msg.get("id") == index and msg.get("type") == "result":
                        if not msg.get("success"):
                            raise RuntimeError(f"{command.get('type')}: {msg.get('error')}")
                        results.append(msg.get("result"))
                        break
        return results
