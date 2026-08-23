"""Engine tests. Pure stdlib: run with `python3 -m unittest discover tests` from the
repository root, no Home Assistant and no pytest required."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPONENT = ROOT / "custom_components" / "ha_scheduler"

# engine.py uses relative imports, so give it a parent package without running the real
# __init__.py — that one imports Home Assistant, which is not installed here.
_PKG = "ha_scheduler_under_test"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [str(COMPONENT)]
sys.modules[_PKG] = _pkg


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", COMPONENT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_load("const")
engine = _load("engine")


class WindowMaths(unittest.TestCase):
    def test_length_across_midnight(self):
        self.assertEqual(engine.win_len({"s": 1200, "e": 300}), 540)

    def test_all_day(self):
        self.assertEqual(engine.win_len({"s": 0, "e": 0}), 1440)

    def test_wrap_splits_at_midnight(self):
        self.assertEqual(
            engine.windows_to_blocks([{"s": 1200, "e": 300}]),
            [{"from": "00:00:00", "to": "05:00:00"}, {"from": "20:00:00", "to": "24:00:00"}],
        )

    def test_all_day_block(self):
        self.assertEqual(
            engine.windows_to_blocks([{"s": 0, "e": 0}]),
            [{"from": "00:00:00", "to": "24:00:00"}],
        )

    def test_overlaps_merge_for_the_helper(self):
        self.assertEqual(
            engine.windows_to_blocks([{"s": 540, "e": 720}, {"s": 600, "e": 780}]),
            [{"from": "09:00:00", "to": "13:00:00"}],
        )

    def test_blocks_never_overlap(self):
        cases = [
            [{"s": 540, "e": 720}, {"s": 600, "e": 780}],
            [{"s": 1200, "e": 300}, {"s": 1320, "e": 60}],
            [{"s": 0, "e": 60}, {"s": 30, "e": 90}, {"s": 80, "e": 1439}],
        ]
        for windows in cases:
            blocks = engine.windows_to_blocks(windows)
            for earlier, later in zip(blocks, blocks[1:]):
                self.assertLessEqual(earlier["to"], later["from"], blocks)

    def test_every_day_is_identical(self):
        days = engine.days_payload([{"s": 60, "e": 120}])
        self.assertEqual(len(days), 7)
        self.assertEqual(len({json.dumps(v) for v in days.values()}), 1)


MODEL = {
    "v": 1,
    "rules": [
        {
            "id": "r1",
            "name": "Gate light overnight",
            "schedule": "schedule.s1",
            "targets": ["switch.gate", "light.porch"],
            "windows": [{"s": 1200, "e": 300}],
            "enabled": True,
        },
        {
            "id": "r2",
            "name": "Paused rule",
            "schedule": "schedule.s2",
            "targets": ["switch.other"],
            "windows": [{"s": 0, "e": 0}],
            "enabled": False,
        },
    ],
}


ONE_WAY_MODEL = {
    "v": 1,
    "rules": [
        {
            "id": "r1",
            "name": "Off at bedtime only",
            "schedule": None,
            "targets": ["switch.gate", "light.porch"],
            "windows": [{"s": None, "e": 1320}],
            "enabled": True,
        },
        {
            "id": "r2",
            "name": "On at dawn only",
            "schedule": None,
            "targets": ["switch.gate"],
            "windows": [{"s": 360, "e": None}],
            "enabled": True,
        },
        {
            "id": "r3",
            "name": "Ordinary window",
            "schedule": "schedule.s3",
            "targets": ["switch.other"],
            "windows": [{"s": 1200, "e": 300}],
            "enabled": True,
        },
    ],
}


class OneWayEntries(unittest.TestCase):
    """A window with one side unset acts only at that moment."""

    def test_edges_become_time_triggers(self):
        built = engine.build_engine(ONE_WAY_MODEL)
        by_id = {t["id"]: t for t in built["triggers"]}
        self.assertEqual(by_id["edge"]["at"], ["06:00:00", "22:00:00"])
        self.assertEqual(by_id["edge"]["trigger"], "time")

    def test_edge_map_is_sorted_and_deduplicated(self):
        self.assertEqual(
            engine.build_engine(ONE_WAY_MODEL)["variables"]["hs_e"],
            {
                "06:00:00": {"on": ["switch.gate"]},
                "22:00:00": {"off": ["light.porch", "switch.gate"]},
            },
        )

    def test_one_way_targets_are_never_state_matched(self):
        built = engine.build_engine(ONE_WAY_MODEL)
        # Only the ordinary rule may appear in the map the sweeps walk, or a boot would
        # force a device that this rule says nothing about.
        self.assertEqual(built["variables"]["hs_m"], {"switch.other": "schedule.s3"})
        revive = next(t for t in built["triggers"] if t["id"] == "revive")
        self.assertEqual(revive["entity_id"], ["switch.other"])

    def test_a_rule_mixing_both_is_all_edges(self):
        model = {"rules": [dict(ONE_WAY_MODEL["rules"][0], windows=[{"s": None, "e": 1320}, {"s": 60, "e": 120}])]}
        built = engine.build_engine(model)
        self.assertEqual(built["variables"]["hs_m"], {})
        self.assertEqual(
            sorted(built["variables"]["hs_e"]), ["01:00:00", "02:00:00", "22:00:00"]
        )

    def test_edges_are_left_out_of_the_helper_blocks(self):
        self.assertEqual(engine.windows_to_blocks([{"s": None, "e": 1320}]), [])
        self.assertEqual(
            engine.windows_to_blocks([{"s": None, "e": 1320}, {"s": 60, "e": 120}]),
            [{"from": "01:00:00", "to": "02:00:00"}],
        )

    def test_disabled_one_way_rule_fires_nothing(self):
        model = {"rules": [dict(ONE_WAY_MODEL["rules"][0], enabled=False)]}
        built = engine.build_engine(model)
        self.assertEqual(built["variables"]["hs_e"], {})
        self.assertNotIn("edge", {t["id"] for t in built["triggers"]})


class BuildEngine(unittest.TestCase):
    def test_disabled_rules_are_left_out(self):
        built = engine.build_engine(MODEL)
        self.assertNotIn("switch.other", built["variables"]["hs_m"])
        self.assertEqual(built["variables"]["hs_m"]["switch.gate"], "schedule.s1")

    def test_whole_model_is_carried_for_the_panel_to_read_back(self):
        self.assertEqual(engine.build_engine(MODEL)["variables"]["hs_cfg"], MODEL)

    def test_empty_model_has_no_state_triggers(self):
        ids = {t["id"] for t in engine.build_engine({"rules": []})["triggers"]}
        self.assertEqual(ids, {"boot", "apply"})


class ParityWithThePanel(unittest.TestCase):
    """The panel writes this automation too, so both builders must agree byte for byte
    or a save from one side would rewrite what the other wrote."""

    def test_javascript_builds_the_same_automation(self):
        if shutil.which("node") is None:
            self.skipTest("node is not installed")
        for model in (MODEL, ONE_WAY_MODEL, {"v": 1, "rules": []}):
            result = subprocess.run(
                ["node", str(Path(__file__).parent / "parity.mjs")],
                input=json.dumps(model),
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(
                json.loads(result.stdout),
                engine.build_engine(model),
                "engine.py and the panel's buildEngine() have drifted",
            )


if __name__ == "__main__":
    unittest.main()
