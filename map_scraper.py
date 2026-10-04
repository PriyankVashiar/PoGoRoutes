#!/usr/bin/env python3
"""Scrape daily Pokémon GO field research quests from regional map endpoints."""

from __future__ import annotations

import json
import logging
import os
import shutil
import stat
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
JSON_DIR = os.path.join(BASE_DIR, "JSON")
CITY_CONFIG_PATH = os.path.join(JSON_DIR, "cities.json")
ARCHIVE_DIR = os.path.join(JSON_DIR, "archive")


def load_city_configs(path: str = CITY_CONFIG_PATH) -> tuple[dict[str, dict], str]:
    """Load the shared city configuration used by the frontend, worker, and scraper."""
    with open(path, "r", encoding="utf-8") as file_obj:
        payload = json.load(file_obj)

    raw_cities = payload.get("cities") if isinstance(payload, dict) else None
    if not isinstance(raw_cities, list) or not raw_cities:
        raise ValueError("City configuration must contain a non-empty 'cities' list")

    cities: dict[str, dict] = {}
    for city in raw_cities:
        if not isinstance(city, dict):
            raise ValueError("City configuration contains a non-object entry")

        city_key = str(city.get("cityKey") or "").strip()
        name = str(city.get("name") or "").strip()
        url = str(city.get("url") or "").strip()
        tz = str(city.get("tz") or "").strip()
        route = city.get("route")
        bounds = route.get("bounds") if isinstance(route, dict) else None
        numeric_fields = (
            city.get("resetHour"),
            city.get("resetMinute"),
            route.get("hexSizeMeters") if isinstance(route, dict) else None,
            bounds.get("minLat") if isinstance(bounds, dict) else None,
            bounds.get("maxLat") if isinstance(bounds, dict) else None,
            bounds.get("minLng") if isinstance(bounds, dict) else None,
            bounds.get("maxLng") if isinstance(bounds, dict) else None,
        )

        if (
            not city_key
            or not name
            or not url
            or not tz
            or not isinstance(bounds, dict)
            or any(not isinstance(value, (int, float)) for value in numeric_fields)
        ):
            raise ValueError("City configuration contains an incomplete city entry")
        if city_key in cities:
            raise ValueError(f"Duplicate city key in configuration: {city_key}")

        cities[city_key] = city

    default_city = str(payload.get("defaultCity") or "").strip()
    if default_city not in cities:
        raise ValueError("City configuration has an invalid defaultCity")

    return cities, default_city


CITIES, DEFAULT_CITY_KEY = load_city_configs()
ARCHIVE_RETENTION_DAYS = 7
CATEGORIES_TO_KEEP = ["t2", "t3", "t7", "t12"]

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
}

MAX_RETRIES = 4
BASE_BACKOFF_SECONDS = 1.5
REQUEST_TIMEOUT_SECONDS = 45
CITY_STATUS_STATES = {"available", "empty", "error"}


def make_city_status(state: str) -> dict[str, str]:
    """Return a structured city availability status for Quest_List.json."""
    if state not in CITY_STATUS_STATES:
        raise ValueError(f"Unsupported city status: {state}")
    updated_at = (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )
    return {"state": state, "updated_at": updated_at}


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("map_scraper")


def request_json_with_retries(
    url: str,
    *,
    params: Any = None,
    headers: dict | None = None,
    max_retries: int = MAX_RETRIES,
) -> Any:
    """Fetch and decode JSON, retrying transport, HTTP, and decode failures."""
    last_error: Exception | None = None
    merged_headers = {**DEFAULT_HEADERS, **(headers or {})}

    for attempt in range(1, max_retries + 1):
        try:
            response = requests.get(
                url, params=params, headers=merged_headers, timeout=REQUEST_TIMEOUT_SECONDS
            )
            response.raise_for_status()
            response.encoding = "utf-8"
            return response.json()
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            if attempt >= max_retries:
                break

            sleep_for = BASE_BACKOFF_SECONDS * (2 ** (attempt - 1))
            log.warning(
                "Request/JSON decode failed (attempt %s/%s) %s — retrying in %.1fs: %s",
                attempt, max_retries, url, sleep_for, exc,
            )
            time.sleep(sleep_for)

    raise RuntimeError(f"Failed after {max_retries} attempts for {url}: {last_error}") from last_error


def today_utc_date_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def archive_day_dir(date_str: str | None = None) -> str:
    day = date_str or today_utc_date_str()
    path = os.path.join(ARCHIVE_DIR, day)
    os.makedirs(path, exist_ok=True)
    return path


def write_json(path: str, data: Any) -> None:
    """Atomically replace a JSON file so interrupted writes cannot truncate it."""
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)

    try:
        target_mode = stat.S_IMODE(os.stat(path).st_mode)
    except FileNotFoundError:
        target_mode = 0o644

    temp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=parent,
            prefix=f".{os.path.basename(path)}.",
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_path = temp_file.name
            json.dump(data, temp_file, indent=2, ensure_ascii=False)
            temp_file.flush()
            os.fsync(temp_file.fileno())

        os.chmod(temp_path, target_mode)
        os.replace(temp_path, path)
        temp_path = None
    finally:
        if temp_path is not None:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def archive_snapshot(filename: str, data: Any, date_str: str | None = None) -> str:
    dest = os.path.join(archive_day_dir(date_str), filename)
    write_json(dest, data)
    log.info("Archived %s", dest)
    return dest


def prune_old_archives(retention_days: int = ARCHIVE_RETENTION_DAYS) -> None:
    if not os.path.isdir(ARCHIVE_DIR):
        return
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=retention_days)
    removed = 0
    for name in os.listdir(ARCHIVE_DIR):
        path = os.path.join(ARCHIVE_DIR, name)
        if not os.path.isdir(path):
            continue
        try:
            folder_date = datetime.strptime(name, "%Y-%m-%d").date()
        except ValueError:
            log.warning("Skipping non-dated archive entry: %s", name)
            continue
        if folder_date < cutoff:
            try:
                shutil.rmtree(path)
                removed += 1
                log.info("Pruned old archive folder: %s", name)
            except OSError as exc:
                log.warning("Failed to prune %s: %s", path, exc)
    if removed:
        log.info("Pruned %s archive folder(s) older than %s days", removed, retention_days)


def ensure_json_dir() -> None:
    os.makedirs(JSON_DIR, exist_ok=True)
    os.makedirs(ARCHIVE_DIR, exist_ok=True)


def load_or_init_quest_list() -> dict:
    quest_list_path = os.path.join(JSON_DIR, "Quest_List.json")
    if os.path.exists(quest_list_path):
        try:
            with open(quest_list_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("Could not load existing Quest_List.json: %s", exc)
    return {"categories": {}}


def _city_request_params(city_key: str) -> tuple[str, dict]:
    """Return (base_url, headers) for a city's quest endpoint."""
    url = CITIES[city_key]["url"]
    return f"{url}/quests.php", {"Referer": f"{url}/"}


def fetch_city_filters(city_key: str) -> dict:
    base_url, headers = _city_request_params(city_key)
    params = {"time": int(datetime.now(timezone.utc).timestamp() * 1000)}
    payload = request_json_with_retries(base_url, params=params, headers=headers)
    if not isinstance(payload, dict):
        raise ValueError(f"Unexpected filters response type from {city_key}")
    return payload.get("filters") or {}


def merge_filter_sets(filter_maps: list) -> dict:
    merged = {}
    for filters in filter_maps:
        for cat_key, raw in filters.items():
            if cat_key not in CATEGORIES_TO_KEEP:
                continue
            items = raw.keys() if isinstance(raw, dict) else (raw or [])
            bucket = merged.setdefault(cat_key, set())
            for item in items:
                bucket.add(str(item))
    return merged


def update_quest_list_structure(quest_list: dict, merged_filters: dict, allow_pruning: bool = True) -> None:
    """Updates master categories structure. 
    
    If allow_pruning is False (e.g. partial fetch or single city target), 
    missing keys are preserved to prevent accidental deletion.
    """
    categories = quest_list.setdefault("categories", {})
    
    if allow_pruning:
        for cat in list(categories.keys()):
            if f"t{cat}" not in CATEGORIES_TO_KEEP:
                del categories[cat]

    for cat_key in CATEGORIES_TO_KEEP:
        clean_cat = cat_key.replace("t", "")
        if clean_cat not in categories:
            categories[clean_cat] = {}
        valid_items = merged_filters.get(cat_key, set())
        
        if clean_cat == "3":
            stardust_dict = categories[clean_cat].setdefault("0", {})
            if allow_pruning:
                for old_amount in list(stardust_dict.keys()):
                    if old_amount not in valid_items:
                        del stardust_dict[old_amount]
            for amount_str in valid_items:
                if amount_str not in stardust_dict or not isinstance(stardust_dict[amount_str], list):
                    stardust_dict[amount_str] = []
        else:
            if allow_pruning:
                for old_id in list(categories[clean_cat].keys()):
                    if old_id not in valid_items:
                        del categories[clean_cat][old_id]
            for reward_str in valid_items:
                if reward_str not in categories[clean_cat]:
                    categories[clean_cat][reward_str] = {}


def fetch_current_quests(city_key: str, quest_list: dict) -> dict:
    base_url, headers = _city_request_params(city_key)
    quest_params = []
    categories = quest_list.get("categories", {})
    for category, items in categories.items():
        if category == "3":
            for stardust_amount in items.get("0", {}).keys():
                quest_params.append(f"{category},{stardust_amount},0")
        else:
            for reward_id in items.keys():
                quest_params.append(f"{category},0,{reward_id}")
    payload = [("quests[]", param) for param in quest_params]
    payload.append(("time", int(datetime.now(timezone.utc).timestamp() * 1000)))
    current_quests_data = request_json_with_retries(base_url, params=payload, headers=headers)
    if not isinstance(current_quests_data, dict):
        raise ValueError(f"Unexpected quest payload type for {city_key}")
    if "quests" not in current_quests_data:
        raise ValueError(f"Missing 'quests' key in payload for {city_key}")
    out_filename = f"{city_key}_quests.json"
    out_path = os.path.join(JSON_DIR, out_filename)
    write_json(out_path, current_quests_data)
    archive_snapshot(out_filename, current_quests_data)
    log.info("Saved %s (%s quests)", out_path, len(current_quests_data.get("quests") or []))
    return current_quests_data


def populate_quest_list(quest_list: dict, current_quests_data: dict) -> None:
    categories = quest_list.get("categories", {})
    quests = current_quests_data.get("quests", []) or []
    for q in quests:
        cat = str(q.get("rewards_types", ""))
        reward_id = str(q.get("rewards_ids", "0"))
        amount = str(q.get("rewards_amounts", "0"))
        condition = (q.get("conditions_string") or "").strip()
        if not cat or not condition or cat not in categories:
            continue
        if cat == "3":
            stardust_dict = categories["3"].setdefault("0", {})
            if amount not in stardust_dict:
                stardust_dict[amount] = []
            if condition not in stardust_dict[amount]:
                stardust_dict[amount].append(condition)
        else:
            reward_dict = categories[cat].setdefault(reward_id, {})
            if amount not in reward_dict or not isinstance(reward_dict[amount], list):
                reward_dict[amount] = []
            if condition not in reward_dict[amount]:
                reward_dict[amount].append(condition)


def rebuild_quest_list_from_snapshots(quest_list: dict) -> bool:
    """Replace conditions with the union of saved city quests, including failed cities.

    Missing or invalid snapshots prevent replacement: without them we cannot
    safely determine which conditions are obsolete.
    """
    candidate = {"categories": {key.replace("t", ""): {} for key in CATEGORIES_TO_KEEP}}
    for city_key in CITIES:
        path = os.path.join(JSON_DIR, f"{city_key}_quests.json")
        try:
            with open(path, "r", encoding="utf-8") as file_obj:
                snapshot = json.load(file_obj)
            if not isinstance(snapshot, dict) or not isinstance(snapshot.get("quests"), list):
                raise ValueError("Snapshot must contain a quests list")
            if any(not isinstance(quest, dict) for quest in snapshot["quests"]):
                raise ValueError("Snapshot contains an invalid quest")
            populate_quest_list(candidate, snapshot)
        except (OSError, ValueError) as exc:
            log.warning("Cannot rebuild conditions from %s; preserving master conditions: %s", path, exc)
            return False
    quest_list["categories"] = candidate["categories"]
    log.info("Rebuilt master quest conditions from saved city snapshots")
    return True


def scrape_city(city_key: str, quest_list: dict) -> bool:
    if city_key not in CITIES:
        raise ValueError(f"Unknown city key: {city_key}")
    city_config = CITIES[city_key]
    log.info("--- Scraping %s (%s) ---", city_config["name"], city_key)
    current_quests = fetch_current_quests(city_key, quest_list)
    populate_quest_list(quest_list, current_quests)
    
    quests = current_quests.get("quests") or []
    return len(quests) > 0


def main() -> int:
    ensure_json_dir()
    quest_list = load_or_init_quest_list()
    
    args = sys.argv[1:]
    is_archive_mode = False
    if len(args) > 0 and args[0].lower() == "archive":
        is_archive_mode = True
        args = args[1:]
        
    target = args[0].lower() if len(args) > 0 else "all"
    
    if target != "all" and target not in CITIES:
        log.error("Unknown city key: %s (valid: %s, all)", target, ", ".join(CITIES))
        return 1

    all_keys = list(CITIES.keys())
    city_keys = all_keys if target == "all" else [target]
    
    if is_archive_mode:
        city_status = quest_list.get("city_status", {})
        if not isinstance(city_status, dict):
            city_status = {}
        for city_key in city_keys:
            out_filename = f"{city_key}_quests.json"
            out_path = os.path.join(JSON_DIR, out_filename)
            try:
                if os.path.exists(out_path):
                    with open(out_path, "r", encoding="utf-8") as f:
                        current_data = json.load(f)
                    archive_snapshot(out_filename, current_data)
                    log.info("Archived %s", out_filename)
            except Exception as e:
                log.error("Failed to archive %s: %s", out_filename, e)
            
            empty_data = {"quests": [], "meta": {"time": int(datetime.now(timezone.utc).timestamp())}}
            write_json(out_path, empty_data)
            city_status[CITIES[city_key]["url"]] = make_city_status("empty")
            log.info("Cleared %s", out_filename)
            
        rebuild_quest_list_from_snapshots(quest_list)
        quest_list["city_status"] = city_status
        quest_list_path = os.path.join(JSON_DIR, "Quest_List.json")
        write_json(quest_list_path, quest_list)
        log.info("Archive mode finished.")
        return 0

    filter_source_keys = all_keys
    
    log.info("--- Updating master list structure from multi-city filters ---")
    filter_maps = []
    filter_errors = []
    for key in filter_source_keys:
        try:
            filters = fetch_city_filters(key)
            filter_maps.append(filters)
            log.info("Fetched filters for %s (%s category keys)", key, len(filters))
        except Exception as exp:
            filter_errors.append(f"{key}: {exp}")
            log.error("Failed to fetch filters for %s: %s", key, exp)

    if not filter_maps:
        log.error("Could not fetch filters from any city. Aborting.")
        for msg in filter_errors:
            log.error("  %s", msg)
        return 1

    merged = merge_filter_sets(filter_maps)

    # Filters describe what to request; saved snapshots determine UI conditions.
    working_quest_list = {"categories": {}}
    update_quest_list_structure(working_quest_list, merged, allow_pruning=True)

    city_status = quest_list.get("city_status", {})
    if not isinstance(city_status, dict):
        city_status = {}

    scrape_errors = []
    for city_key in city_keys:
        try:
            has_quests = scrape_city(city_key, working_quest_list)
            city_status[CITIES[city_key]["url"]] = make_city_status(
                "available" if has_quests else "empty"
            )
        except Exception as exp:
            # Distinguish scraper/API failures from a successful scrape that
            # genuinely returned zero quests.
            city_status[CITIES[city_key]["url"]] = make_city_status("error")
            scrape_errors.append(f"{city_key}: {exp}")
            log.error("Scrape failed for %s: %s", city_key, exp)

    rebuild_quest_list_from_snapshots(quest_list)

    quest_list["city_status"] = city_status
    quest_list_path = os.path.join(JSON_DIR, "Quest_List.json")
    write_json(quest_list_path, quest_list)
    archive_snapshot("Quest_List.json", quest_list)
    log.info("Updated master list: %s", quest_list_path)

    prune_old_archives()

    if scrape_errors:
        log.error("Pipeline finished with %s city failure(s):", len(scrape_errors))
        for msg in scrape_errors:
            log.error("  %s", msg)
        return 1

    log.info("Pipeline finished successfully")
    return 0


if __name__ == "__main__":
    sys.exit(main())