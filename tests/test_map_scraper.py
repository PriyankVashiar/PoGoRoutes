from __future__ import annotations

import copy
import json
import importlib.util
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("map_scraper", ROOT / "map_scraper.py")
map_scraper = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(map_scraper)


class SharedCityConfigTests(unittest.TestCase):
    def test_scraper_loads_shared_city_configuration(self):
        config_path = ROOT / "JSON" / "cities.json"
        payload = json.loads(config_path.read_text(encoding="utf-8"))
        expected_keys = [city["cityKey"] for city in payload["cities"]]

        self.assertEqual(list(map_scraper.CITIES), expected_keys)
        self.assertEqual(map_scraper.DEFAULT_CITY_KEY, payload["defaultCity"])
        self.assertEqual(map_scraper.CITIES["nyc"]["url"], "https://nycpokemap.com")
        self.assertIn("bounds", map_scraper.CITIES["nyc"]["route"])


class QuestListRefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        self.old_quest_list = {
            "categories": {
                "2": {
                    "1": {
                        "1": ["OLD CONDITION"]
                    }
                }
            },
            "city_status": {
                config["url"]: True for config in map_scraper.CITIES.values()
            },
        }
        self.filters = {"t2": {"1": {}}}

    def run_main(self, scrape_side_effect):
        writes = []

        def capture_write(path, data):
            writes.append((path, copy.deepcopy(data)))

        with (
            mock.patch.object(map_scraper, "ensure_json_dir"),
            mock.patch.object(
                map_scraper,
                "load_or_init_quest_list",
                return_value=copy.deepcopy(self.old_quest_list),
            ),
            mock.patch.object(
                map_scraper,
                "fetch_city_filters",
                side_effect=lambda _key: copy.deepcopy(self.filters),
            ),
            mock.patch.object(map_scraper, "scrape_city", side_effect=scrape_side_effect),
            mock.patch.object(map_scraper, "write_json", side_effect=capture_write),
            mock.patch.object(map_scraper, "archive_snapshot"),
            mock.patch.object(map_scraper, "prune_old_archives"),
            mock.patch.object(sys, "argv", ["map_scraper.py", "all"]),
        ):
            exit_code = map_scraper.main()

        self.assertTrue(writes, "main() should write the final Quest_List.json")
        return exit_code, writes[-1][1]

    def test_successful_all_city_refresh_removes_stale_conditions(self):
        def scrape_city(_city_key, working_quest_list):
            map_scraper.populate_quest_list(
                working_quest_list,
                {
                    "quests": [
                        {
                            "rewards_types": "2",
                            "rewards_ids": "1",
                            "rewards_amounts": "1",
                            "conditions_string": "NEW CONDITION",
                        }
                    ]
                },
            )
            return True

        exit_code, final_quest_list = self.run_main(scrape_city)

        self.assertEqual(exit_code, 0)
        conditions = final_quest_list["categories"]["2"]["1"]["1"]
        self.assertEqual(conditions, ["NEW CONDITION"])
        self.assertNotIn("OLD CONDITION", conditions)

    def test_failed_all_city_refresh_preserves_last_known_good_conditions(self):
        call_count = 0

        def scrape_city(_city_key, working_quest_list):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise RuntimeError("synthetic city failure")

            map_scraper.populate_quest_list(
                working_quest_list,
                {
                    "quests": [
                        {
                            "rewards_types": "2",
                            "rewards_ids": "1",
                            "rewards_amounts": "1",
                            "conditions_string": "NEW CONDITION",
                        }
                    ]
                },
            )
            return True

        exit_code, final_quest_list = self.run_main(scrape_city)

        self.assertEqual(exit_code, 1)
        conditions = final_quest_list["categories"]["2"]["1"]["1"]
        self.assertEqual(conditions, ["OLD CONDITION"])
        self.assertNotIn("NEW CONDITION", conditions)

        # The second scrape in CITIES order is Vancouver. Its previous True
        # status must not survive a failed refresh. Successful cities remain True.
        self.assertFalse(
            final_quest_list["city_status"][map_scraper.CITIES["vc"]["url"]]
        )
        self.assertTrue(
            final_quest_list["city_status"][map_scraper.CITIES["nyc"]["url"]]
        )


class ScraperDurabilityTests(unittest.TestCase):
    class FakeResponse:
        def __init__(self, *, payload=None, json_error=None):
            self.payload = payload
            self.json_error = json_error
            self.encoding = None

        def raise_for_status(self):
            return None

        def json(self):
            if self.json_error is not None:
                raise self.json_error
            return self.payload

    def test_json_decode_failure_is_retried(self):
        responses = [
            self.FakeResponse(json_error=ValueError("truncated JSON")),
            self.FakeResponse(payload={"filters": {"t2": {"1": {}}}}),
        ]

        with (
            mock.patch.object(map_scraper.requests, "get", side_effect=responses) as get_mock,
            mock.patch.object(map_scraper.time, "sleep") as sleep_mock,
        ):
            payload = map_scraper.request_json_with_retries(
                "https://example.invalid/quests.php",
                max_retries=2,
            )

        self.assertEqual(payload, {"filters": {"t2": {"1": {}}}})
        self.assertEqual(get_mock.call_count, 2)
        sleep_mock.assert_called_once_with(map_scraper.BASE_BACKOFF_SECONDS)

    def test_atomic_write_preserves_existing_file_when_serialization_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = pathlib.Path(temp_dir) / "Quest_List.json"
            original = {"version": "known-good"}
            path.write_text(json.dumps(original), encoding="utf-8")

            def fail_mid_write(_data, file_obj, **_kwargs):
                file_obj.write('{"version":')
                raise RuntimeError("synthetic serialization failure")

            with mock.patch.object(map_scraper.json, "dump", side_effect=fail_mid_write):
                with self.assertRaisesRegex(RuntimeError, "synthetic serialization failure"):
                    map_scraper.write_json(str(path), {"version": "new"})

            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), original)
            self.assertEqual(list(path.parent.glob(".Quest_List.json.*.tmp")), [])

    def test_atomic_write_replaces_file_with_valid_json(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = pathlib.Path(temp_dir) / "quests.json"
            path.write_text('{"old": true}', encoding="utf-8")

            map_scraper.write_json(str(path), {"new": True})

            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"new": True})
            self.assertEqual(list(path.parent.glob(".quests.json.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
