#!/usr/bin/env python3
"""
get-keys.py  —  Extract Tuya local_key values via tinytuya wizard
                Writes keys back into devices.json automatically.

Prerequisites
-------------
  source .venv/bin/activate
  # (tinytuya is already installed in .venv)

Usage
-----
  python3 get-keys.py

The script will prompt you for Tuya IoT Platform credentials,
then query the cloud API to find local_keys for the two ECOSO devices.

If your devices are on a non-standard OEM cloud (ECOSO partition),
see README.md — "Part 3: Getting local_key" for alternatives.
"""

import json
import sys
import os
from pathlib import Path

# ── load .env if present ─────────────────────────────────────────────────────

_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip())

# ── sanity check ──────────────────────────────────────────────────────────────

try:
    import tinytuya
except ImportError:
    sys.exit("tinytuya not found — run: source .venv/bin/activate")

DEVICES_FILE = Path(__file__).parent / "devices.json"


def load_target_ids() -> set[str]:
    """Load target device IDs from env or local devices.json.

    Env override: TARGET_IDS="id1,id2,..."
    """
    env_ids = os.getenv("TARGET_IDS", "").strip()
    if env_ids:
        return {item.strip() for item in env_ids.split(",") if item.strip()}

    if DEVICES_FILE.exists():
        try:
            data = json.loads(DEVICES_FILE.read_text())
            return {
                dev.get("id", "")
                for dev in data.get("devices", [])
                if isinstance(dev, dict) and dev.get("id")
            }
        except Exception:
            return set()

    return set()

# ── wizard / cloud lookup ──────────────────────────────────────────────────────

def run_wizard():
    """Run tinytuya interactive wizard which queries the Tuya cloud API."""
    target_ids = load_target_ids()
    if not target_ids:
        sys.exit(
            "No target IDs configured. Add device IDs to local devices.json "
            "or set TARGET_IDS=id1,id2 in your shell."
        )
    if not DEVICES_FILE.exists():
        sys.exit(
            "devices.json not found. Create a local ignored devices.json first "
            "or set TARGET_IDS and add devices.json for key patching."
        )

    print("\n=== tinytuya Cloud Wizard ===")
    print("You need credentials from https://iot.tuya.com")
    print("  1. Create a free developer account")
    print("  2. Create a Cloud Project (any name)")
    print("  3. Link your devices via 'Smart Home' tab")
    print("  4. Note your API Key (Access ID) and API Secret\n")

    api_key    = os.environ.get("TUYA_API_KEY") or input("Tuya IoT API Key    : ").strip()
    api_secret = os.environ.get("TUYA_API_SECRET") or input("Tuya IoT API Secret : ").strip()
    api_region = os.environ.get("TUYA_REGION") or input("Region [cn/us/eu/in] (eu for Norway): ").strip() or "eu"
    app_uid    = os.environ.get("TUYA_APP_UID") or input("Your Smart Life / Tuya App account UID (optional, press Enter to skip): ").strip()

    print(f"  API Key : {api_key}")
    print(f"  Region  : {api_region}")
    print(f"  App UID : {app_uid or '(not set)'}")

    if not api_key or not api_secret:
        sys.exit("API key and secret are required.")

    # Use tinytuya Cloud class directly
    cloud = tinytuya.Cloud(
        apiRegion=api_region,
        apiKey=api_key,
        apiSecret=api_secret,
        apiDeviceID=app_uid if app_uid else None,
        new_sign_algorithm=True,
    )

    print("\nQuerying cloud for device list…")
    try:
        devices = cloud.getdevices()
    except Exception as exc:
        print(f"Cloud query failed: {exc}")
        print("\nThis usually means:")
        print("  • The devices are on a different OEM cloud partition")
        print("  • Your cloud project does not have the 'Smart Home' service")
        print("\nSee README.md § 'Non-standard OEM cloud' for next steps.")
        return

    if not devices:
        print("Cloud returned no devices — see README.md § 'Non-standard OEM cloud'.")
        return

    # tinytuya sometimes returns a mix of dicts and strings — filter to dicts only
    devices = [d for d in devices if isinstance(d, dict)]

    print(f"\nCloud returned {len(devices)} device(s):")
    for d in devices:
        dev_id = d.get("id", "")
        marker = "  ← target" if dev_id in target_ids else ""
        print(f"  {dev_id}  {d.get('name', '(no name)')}  key={d.get('key', '??')}{marker}")

    # ── debug: dump raw cloud fields for target devices ──────────────────────
    targets_found = [d for d in devices if d.get("id") in target_ids]
    if targets_found:
        print("\n── Raw cloud fields for target devices ──────────────────────────")
        for d in targets_found:
            print(f"\n  Device: {d.get('name', '(no name)')}  ID: {d.get('id')}")
            interesting = ["id", "key", "local_key", "uuid", "mac", "ip",
                           "version", "active_time", "update_time", "create_time",
                           "online", "category", "product_id", "sub", "owner_id"]
            for field in interesting:
                if field in d:
                    print(f"    {field:20s}: {d[field]}")
            # print any unexpected fields that might carry key material
            extra = {k: v for k, v in d.items() if k not in interesting}
            if extra:
                print(f"    -- extra fields --")
                for k, v in extra.items():
                    print(f"    {k:20s}: {v}")
        print("─────────────────────────────────────────────────────────────────")
    else:
        print("\n  ⚠ None of the target IDs were found in the cloud response.")
        print("  Target IDs:", target_ids)
        print("\n  All devices returned by cloud (may have new IDs after re-pairing):")
        for d in devices:
            print(f"    id={d.get('id')}  name={d.get('name')}  key={d.get('key', '??')}  ip={d.get('ip', '?')}")

    # ── patch devices.json ────────────────────────────────────────────────────
    key_map = {d["id"]: d.get("key", "") for d in devices if d.get("key")}
    found = {did for did in target_ids if key_map.get(did)}

    if not found:
        print("\nNo local_keys found for the target devices in this cloud account.")
        print("See README.md § 'Non-standard OEM cloud' for next steps.")
        return

    devices_cfg = json.loads(DEVICES_FILE.read_text())
    updated = 0
    for dev in devices_cfg["devices"]:
        if dev["id"] in target_ids and dev["id"] in key_map:
            dev["key"] = key_map[dev["id"]]
            updated += 1

    DEVICES_FILE.write_text(json.dumps(devices_cfg, indent=2))
    print(f"\n✓ Updated {updated} device(s) in devices.json with local_keys.")
    print("  You can now run: npx ts-node src/index.ts discover")


if __name__ == "__main__":
    run_wizard()
