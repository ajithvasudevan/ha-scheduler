"""Window maths and the generated engine automation.

Deliberately free of Home Assistant imports so it can be unit-tested on its own, and
kept byte-for-byte in step with buildEngine() in the panel's JavaScript — tests/ checks
that with the real file.
"""

from __future__ import annotations

from .const import (
    ALLOWED_DOMAINS,
    APPLY_EVENT,
    DAYS,
    ENGINE_ALIAS,
    ENGINE_DESCRIPTION,
    ENGINE_ID,
)

__all__ = [
    "ALLOWED_DOMAINS",
    "build_engine",
    "daymask",
    "days_payload",
    "has_edges",
    "has_solar",
    "intervals_of",
    "is_edge",
    "is_solar",
    "merge_spans",
    "to_spans",
    "win_len",
    "windows_to_blocks",
]


def is_edge(w: dict) -> bool:
    """A window with one side unset is an *edge*: "turn on at 06:00" or "turn off at
    22:00", saying nothing about the rest of the day. A rule holding any of them
    switches only at the moments it lists, so it asserts no state in between and is
    never restored at boot or by an apply."""
    return w.get("s") is None or w.get("e") is None


def is_solar(v: object) -> bool:
    """A solar time side: {"sun": "sunrise"|"sunset", "offset": <int minutes>}."""
    return isinstance(v, dict) and v.get("sun") in ("sunrise", "sunset")


def has_edges(windows: list[dict] | None) -> bool:
    return any(is_edge(w) for w in windows or [])


def has_solar(windows: list[dict] | None) -> bool:
    """True if any window side is a solar time (sunrise/sunset ± offset)."""
    return any(is_solar(w.get("s")) or is_solar(w.get("e")) for w in windows or [])


def intervals_of(windows: list[dict] | None) -> list[dict]:
    """Fixed-time interval windows only — excludes one-way (null side) and solar windows."""
    return [
        w for w in windows or []
        if not is_edge(w) and not is_solar(w.get("s")) and not is_solar(w.get("e"))
    ]


def _clock(minutes: int) -> str:
    return "%02d:%02d:00" % (minutes // 60, minutes % 60)


def win_len(w: dict) -> int:
    """Minutes a window covers. e <= s wraps past midnight; {s: 0, e: 0} is all day."""
    return w["e"] - w["s"] if w["e"] > w["s"] else 1440 - w["s"] + w["e"]


def to_spans(windows: list[dict]) -> list[list[int]]:
    spans: list[list[int]] = []
    for w in intervals_of(windows):
        if win_len(w) >= 1440:
            return [[0, 1440]]
        if w["e"] > w["s"]:
            spans.append([w["s"], w["e"]])
        else:
            if w["s"] < 1440:
                spans.append([w["s"], 1440])
            if w["e"] > 0:
                spans.append([0, w["e"]])
    return spans


def merge_spans(spans: list[list[int]]) -> list[list[int]]:
    out: list[list[int]] = []
    for cur in sorted(spans, key=lambda s: s[0]):
        if out and cur[0] <= out[-1][1]:
            out[-1][1] = max(out[-1][1], cur[1])
        else:
            out.append(list(cur))
    return out


def windows_to_blocks(windows: list[dict]) -> list[dict]:
    """Overlaps are merged only here. Home Assistant rejects overlapping schedule
    blocks, and a union of on-periods is what the device experiences either way."""
    return [
        {
            "from": "%02d:%02d:00" % (sp[0] // 60, sp[0] % 60),
            "to": "24:00:00" if sp[1] >= 1440 else "%02d:%02d:00" % (sp[1] // 60, sp[1] % 60),
        }
        for sp in merge_spans(to_spans(windows))
    ]


def daymask(days: list | None) -> str:
    """A 7-char Monday..Sunday mask: '1' on an active weekday, '0' otherwise. None, an
    empty list, or all seven days all mean "every day" and give '1111111' — so a rule
    saved by an older version of the integration (no `days` field at all) behaves
    exactly as it always did."""
    s = {int(d) for d in days} if days else set()
    if not s or len(s) >= 7:
        return "1111111"
    return "".join("1" if i in s else "0" for i in range(7))


def days_payload(windows: list[dict], days: list | None = None) -> dict:
    """windows -> the per-weekday block map a schedule helper stores.

    `days` restricts the rule to a set of weekdays (0=Monday). None/empty/all-seven is
    every day and reproduces the old behaviour exactly. A window that wraps past
    midnight contributes its after-midnight tail to the following calendar day, so a
    weekday-restricted wrapping window still spills into the next morning as authored.
    """
    active = set(range(7)) if daymask(days) == "1111111" else {int(d) for d in days}
    per: dict[int, list[list[int]]] = {d: [] for d in range(7)}
    for w in intervals_of(windows):
        if win_len(w) >= 1440:
            for d in active:
                per[d].append([0, 1440])
            continue
        if w["e"] > w["s"]:
            for d in active:
                per[d].append([w["s"], w["e"]])
        else:
            for d in active:
                per[d].append([w["s"], 1440])
                # A window ending exactly at midnight (e == 0) does not spill into the
                # next day; only a true wrap (e > 0) contributes an after-midnight tail.
                if w["e"] > 0:
                    per[(d + 1) % 7].append([0, w["e"]])
    return {
        DAYS[d]: [
            {
                "from": "%02d:%02d:00" % (sp[0] // 60, sp[0] % 60),
                "to": "24:00:00" if sp[1] >= 1440 else "%02d:%02d:00" % (sp[1] // 60, sp[1] % 60),
            }
            for sp in merge_spans(per[d])
        ]
        for d in range(7)
    }


def _solar_offset_str(offset: int) -> str:
    """Format a minute offset as ±HH:MM:00 for HA's sun trigger."""
    sign = "+" if offset >= 0 else "-"
    m = abs(int(offset))
    return f"{sign}{m // 60:02d}:{m % 60:02d}:00"


def _solar_tid(event: str, offset: int) -> str:
    return f"solar_{event}_{int(offset):+d}"


def build_engine(model: dict) -> dict:
    """The single automation that switches everything.

    Three rule types:
    - State rules: backed by a schedule.* helper. Engine reacts to helper state changes,
      boot, apply, and device-revive. Correct on/off is a pure function of wall clock.
    - Edge rules: one-way (null side). Fire only at their listed fixed moments.
    - Solar rules: any window side is a sunrise/sunset time. Fire at sun triggers and at
      any fixed-time sides. Not restored at boot/revive (solar times are not pre-computed).
    """
    live = [
        r
        for r in model.get("rules", [])
        if r.get("enabled", True) is not False and r.get("targets")
    ]

    # Classify: solar rules are separated out first so they never end up in the schedule
    # helper maps (helpers only understand fixed times).
    solar_live = [r for r in live if has_solar(r.get("windows"))]
    non_solar_live = [r for r in live if not has_solar(r.get("windows"))]

    rules = [r for r in non_solar_live if r.get("schedule") and not has_edges(r.get("windows"))]
    m: dict[str, str] = {}       # target entity  -> schedule entity
    s2t: dict[str, list[str]] = {}  # schedule entity -> [target entities]
    for r in rules:
        s2t[r["schedule"]] = list(r["targets"])
        for t in r["targets"]:
            m[t] = r["schedule"]

    # Fixed-time edge map: "HH:MM:00" -> {"on": [[entity, mask], ...], "off": [...]}
    # Populated from non-solar one-way rules AND from the fixed sides of solar rules.
    # Each entity carries its rule's 7-char weekday mask so the engine can skip it on a
    # day the rule does not cover (an all-day rule's mask is "1111111", so it never does).
    edges: dict[str, dict[str, list[list[str]]]] = {}

    def _add_edge(at: str, action: str, targets: list[str], mask: str) -> None:
        slot = edges.setdefault(at, {}).setdefault(action, [])
        for t in targets:
            if not any(p[0] == t for p in slot):
                slot.append([t, mask])

    for r in non_solar_live:
        if not has_edges(r.get("windows")):
            continue
        mask = daymask(r.get("days"))
        for w in r.get("windows") or []:
            for side, action in (("s", "on"), ("e", "off")):
                if w.get(side) is None:
                    continue
                _add_edge(_clock(w[side]), action, r["targets"], mask)

    # Solar edge map: solar_tid -> {"on": [[entity, mask], ...], "off": [...]}
    # Also collect the fixed sides of solar rules into the fixed-time edge map above.
    solar_e: dict[str, dict] = {}  # solar_tid -> {event, offset, on: [], off: []}
    for r in solar_live:
        mask = daymask(r.get("days"))
        for w in r.get("windows") or []:
            for side, action in (("s", "on"), ("e", "off")):
                v = w.get(side)
                if v is None:
                    continue
                if is_solar(v):
                    event = v["sun"]
                    offset = int(v.get("offset", 0))
                    tid = _solar_tid(event, offset)
                    if tid not in solar_e:
                        solar_e[tid] = {"event": event, "offset": offset, "on": [], "off": []}
                    slot = solar_e[tid][action]
                    for t in r["targets"]:
                        if not any(p[0] == t for p in slot):
                            slot.append([t, mask])
                else:
                    # Fixed side of a solar rule — use a plain time trigger.
                    _add_edge(_clock(v), action, r["targets"], mask)

    edge_times = sorted(edges)
    e = {
        at: {
            action: sorted(edges[at][action], key=lambda p: p[0])
            for action in ("on", "off")
            if action in edges[at]
        }
        for at in edge_times
    }
    # Strip internal keys before storing in automation variables, and drop empty on/off
    # lists so the output matches the panel's buildEngine() byte-for-byte (admin saves and
    # non-admin service saves then produce an identical engine).
    hs_solar_e = {}
    for tid, data in sorted(solar_e.items()):
        entry = {}
        for k in ("on", "off"):
            if data.get(k):
                entry[k] = sorted(data[k], key=lambda p: p[0])
        hs_solar_e[tid] = entry

    triggers: list[dict] = [
        {"trigger": "homeassistant", "event": "start", "id": "boot"},
        {"trigger": "event", "event_type": APPLY_EVENT, "id": "apply"},
    ]
    # `for` swallows the 1-microsecond off/on blip a wrapping window produces at
    # midnight, where one day's block ends 23:59:59.999999 and the next starts 00:00.
    if s2t:
        triggers.append(
            {
                "trigger": "state",
                "entity_id": sorted(s2t),
                "to": ["on", "off"],
                "for": {"seconds": 3},
                "id": "sched",
            }
        )
    # A target coming back from unavailable is a device or network outage ending.
    # Re-asserting only here (and at boot) is what keeps manual overrides alive.
    if m:
        triggers.append(
            {
                "trigger": "state",
                "entity_id": sorted(m),
                "from": ["unavailable", "unknown"],
                "for": {"seconds": 5},
                "id": "revive",
            }
        )
    if edge_times:
        triggers.append({"trigger": "time", "at": edge_times, "id": "edge"})
    # One sun trigger per unique (event, offset) across all solar rules.
    for tid in sorted(solar_e):
        data = solar_e[tid]
        triggers.append({
            "trigger": "sun",
            "event": data["event"],
            "offset": _solar_offset_str(data["offset"]),
            "id": tid,
        })

    return {
        "id": ENGINE_ID,
        "alias": ENGINE_ALIAS,
        "description": ENGINE_DESCRIPTION,
        "mode": "parallel",
        "max": 60,
        "variables": {"hs_m": m, "hs_s2t": s2t, "hs_e": e, "hs_solar_e": hs_solar_e, "hs_cfg": model},
        "triggers": triggers,
        "conditions": [],
        "actions": [
            {
                "variables": {
                    # Solar and edge triggers are handled by their own dedicated branches below;
                    # boot/apply sweep only state-rule targets (those backed by schedule helpers).
                    "hs_todo": "{% if trigger.id == 'sched' %}{{ hs_s2t.get(trigger.entity_id, []) }}"
                    "{% elif trigger.id == 'revive' %}{{ [trigger.entity_id] }}"
                    "{% elif trigger.id == 'boot' or trigger.id == 'apply' %}{{ hs_m.keys() | list }}"
                    "{% else %}{{ [] }}{% endif %}"
                }
            },
            # Give integrations time to bring their entities up before the boot sweep.
            {
                "if": [{"condition": "template", "value_template": "{{ trigger.id == 'boot' }}"}],
                "then": [{"delay": {"seconds": 40}}],
            },
            {
                "repeat": {
                    "for_each": "{{ hs_todo }}",
                    "sequence": [
                        {
                            "variables": {
                                "hs_w": "{{ states(hs_m[repeat.item]) if repeat.item in hs_m else 'skip' }}",
                                "hs_cur": "{{ states(repeat.item) }}",
                            }
                        },
                        {
                            "if": [
                                {
                                    "condition": "template",
                                    "value_template": "{{ hs_w in ['on','off'] and hs_cur not in "
                                    "['unavailable','unknown','none',''] and hs_cur != hs_w }}",
                                }
                            ],
                            "then": [
                                {
                                    "action": "homeassistant.turn_{{ hs_w }}",
                                    "target": {"entity_id": "{{ repeat.item }}"},
                                }
                            ],
                        },
                    ],
                }
            },
            {
                # Edge rules say nothing about the state in between, so this is a plain
                # switch at the moment that fired — no comparison, nothing to restore.
                "if": [{"condition": "template", "value_template": "{{ trigger.id == 'edge' }}"}],
                "then": [
                    {"variables": {"hs_at": "{{ trigger.now.strftime('%H:%M:00') }}"}},
                    {
                        "variables": {
                            # Each entry is [entity, weekday-mask]; keep only those whose mask
                            # has today set. An all-day rule's mask is all 1s, so it always passes.
                            "hs_on": "{% set wd = now().weekday() %}{% set ns = namespace(l=[]) %}"
                            "{% for p in hs_e.get(hs_at, {}).get('on', []) %}"
                            "{% if p[1][wd] == '1' %}{% set ns.l = ns.l + [p[0]] %}{% endif %}{% endfor %}{{ ns.l }}",
                            "hs_off": "{% set wd = now().weekday() %}{% set ns = namespace(l=[]) %}"
                            "{% for p in hs_e.get(hs_at, {}).get('off', []) %}"
                            "{% if p[1][wd] == '1' %}{% set ns.l = ns.l + [p[0]] %}{% endif %}{% endfor %}{{ ns.l }}",
                        }
                    },
                    {
                        "if": [{"condition": "template", "value_template": "{{ hs_on | count > 0 }}"}],
                        "then": [
                            {"action": "homeassistant.turn_on", "target": {"entity_id": "{{ hs_on }}"}}
                        ],
                    },
                    {
                        "if": [{"condition": "template", "value_template": "{{ hs_off | count > 0 }}"}],
                        "then": [
                            {"action": "homeassistant.turn_off", "target": {"entity_id": "{{ hs_off }}"}}
                        ],
                    },
                ],
            },
            {
                # Solar triggers fire at the exact sunrise/sunset moment (± offset).
                # Each trigger id matches a key in hs_solar_e which lists entities to switch.
                "if": [{"condition": "template", "value_template": "{{ trigger.id.startswith('solar_') }}"}],
                "then": [
                    {
                        "variables": {
                            # Each entry is [entity, weekday-mask]; keep only today's.
                            "hs_solar_on": "{% set wd = now().weekday() %}{% set ns = namespace(l=[]) %}"
                            "{% for p in hs_solar_e.get(trigger.id, {}).get('on', []) %}"
                            "{% if p[1][wd] == '1' %}{% set ns.l = ns.l + [p[0]] %}{% endif %}{% endfor %}{{ ns.l }}",
                            "hs_solar_off": "{% set wd = now().weekday() %}{% set ns = namespace(l=[]) %}"
                            "{% for p in hs_solar_e.get(trigger.id, {}).get('off', []) %}"
                            "{% if p[1][wd] == '1' %}{% set ns.l = ns.l + [p[0]] %}{% endif %}{% endfor %}{{ ns.l }}",
                        }
                    },
                    {
                        "if": [{"condition": "template", "value_template": "{{ hs_solar_on | count > 0 }}"}],
                        "then": [
                            {"action": "homeassistant.turn_on", "target": {"entity_id": "{{ hs_solar_on }}"}}
                        ],
                    },
                    {
                        "if": [{"condition": "template", "value_template": "{{ hs_solar_off | count > 0 }}"}],
                        "then": [
                            {"action": "homeassistant.turn_off", "target": {"entity_id": "{{ hs_solar_off }}"}}
                        ],
                    },
                ],
            },
        ],
    }
