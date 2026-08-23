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
    "days_payload",
    "has_edges",
    "intervals_of",
    "is_edge",
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


def has_edges(windows: list[dict] | None) -> bool:
    return any(is_edge(w) for w in windows or [])


def intervals_of(windows: list[dict] | None) -> list[dict]:
    return [w for w in windows or [] if not is_edge(w)]


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


def days_payload(windows: list[dict]) -> dict:
    blocks = windows_to_blocks(windows)
    return {d: blocks for d in DAYS}  # every day identical, by design


def build_engine(model: dict) -> dict:
    """The single automation that switches everything.

    Timing truth stays in the schedule.* helpers, whose state is a pure function of the
    wall clock; this automation only reacts to their edges, to a restart, to a device
    coming back from unavailable, and to the apply event.
    """
    live = [
        r
        for r in model.get("rules", [])
        if r.get("enabled", True) is not False and r.get("targets")
    ]
    # Two kinds of rule: state rules follow a schedule helper continuously; edge rules
    # only fire at the times they name.
    rules = [r for r in live if r.get("schedule") and not has_edges(r.get("windows"))]
    m: dict[str, str] = {}      # target entity -> schedule entity
    s2t: dict[str, list[str]] = {}  # schedule entity -> [target entities]
    for r in rules:
        s2t[r["schedule"]] = list(r["targets"])
        for t in r["targets"]:
            m[t] = r["schedule"]

    # "HH:MM:00" -> {"on": [entities], "off": [entities]}. Sorted and de-duplicated so
    # the generated automation is byte-identical whichever side wrote it.
    edges: dict[str, dict[str, list[str]]] = {}
    for r in (x for x in live if has_edges(x.get("windows"))):
        for w in r.get("windows") or []:
            for side, action in (("s", "on"), ("e", "off")):
                if w.get(side) is None:
                    continue
                slot = edges.setdefault(_clock(w[side]), {}).setdefault(action, [])
                for t in r["targets"]:
                    if t not in slot:
                        slot.append(t)
    edge_times = sorted(edges)
    e = {
        at: {action: sorted(edges[at][action]) for action in ("on", "off") if action in edges[at]}
        for at in edge_times
    }

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
    # Edges are wall-clock moments, so they are plain time triggers.
    if edge_times:
        triggers.append({"trigger": "time", "at": edge_times, "id": "edge"})

    return {
        "id": ENGINE_ID,
        "alias": ENGINE_ALIAS,
        "description": ENGINE_DESCRIPTION,
        "mode": "parallel",
        "max": 60,
        "variables": {"tsvk_m": m, "tsvk_s2t": s2t, "tsvk_e": e, "tsvk_cfg": model},
        "triggers": triggers,
        "conditions": [],
        "actions": [
            {
                "variables": {
                    "tsvk_todo": "{% if trigger.id == 'sched' %}{{ tsvk_s2t.get(trigger.entity_id, []) }}"
                    "{% elif trigger.id == 'revive' %}{{ [trigger.entity_id] }}"
                    "{% elif trigger.id == 'edge' %}{{ [] }}"
                    "{% else %}{{ tsvk_m.keys() | list }}{% endif %}"
                }
            },
            # Give integrations time to bring their entities up before the boot sweep.
            {
                "if": [{"condition": "template", "value_template": "{{ trigger.id == 'boot' }}"}],
                "then": [{"delay": {"seconds": 40}}],
            },
            {
                "repeat": {
                    "for_each": "{{ tsvk_todo }}",
                    "sequence": [
                        {
                            "variables": {
                                "tsvk_w": "{{ states(tsvk_m[repeat.item]) if repeat.item in tsvk_m else 'skip' }}",
                                "tsvk_cur": "{{ states(repeat.item) }}",
                            }
                        },
                        {
                            "if": [
                                {
                                    "condition": "template",
                                    "value_template": "{{ tsvk_w in ['on','off'] and tsvk_cur not in "
                                    "['unavailable','unknown','none',''] and tsvk_cur != tsvk_w }}",
                                }
                            ],
                            "then": [
                                {
                                    "action": "homeassistant.turn_{{ tsvk_w }}",
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
                    {"variables": {"tsvk_at": "{{ trigger.now.strftime('%H:%M:00') }}"}},
                    {
                        "variables": {
                            "tsvk_on": "{{ tsvk_e.get(tsvk_at, {}).get('on', []) }}",
                            "tsvk_off": "{{ tsvk_e.get(tsvk_at, {}).get('off', []) }}",
                        }
                    },
                    {
                        "if": [{"condition": "template", "value_template": "{{ tsvk_on | count > 0 }}"}],
                        "then": [
                            {"action": "homeassistant.turn_on", "target": {"entity_id": "{{ tsvk_on }}"}}
                        ],
                    },
                    {
                        "if": [{"condition": "template", "value_template": "{{ tsvk_off | count > 0 }}"}],
                        "then": [
                            {"action": "homeassistant.turn_off", "target": {"entity_id": "{{ tsvk_off }}"}}
                        ],
                    },
                ],
            },
        ],
    }
