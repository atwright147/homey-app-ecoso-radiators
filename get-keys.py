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

# ── sanity check ──────────────────────────────────────────────────────────────

try:
    import tinytuya
except ImportError:
    sys.exit("tinytuya not found — run: source .venv/bin/activate")

DEVICES_FILE = Path(__file__).parent / "devices.json"
TARGET_IDS = {"<tuya-device-id-1>", "<tuya-device-id-2>"}

# ── wizard / cloud lookup ──────────────────────────────────────────────────────

def run_wizard():
    """Run tinytuya interactive wizard which queries the Tuya cloud API."""
    print("\n=== tinytuya Cloud Wizard ===")
    print("You need credentials from https://iot.tuya.com")
    print("  1. Create a free developer account")
    print("  2. Create a Cloud Project (any name)")
    print("  3. Link your devices via 'Smart Home' tab")
    print("  4. Note your API Key (Access ID) and API Secret\n")

    api_key    = input("Tuya IoT API Key    : ").strip()
    api_secret = input("Tuya IoT API Secret : ").strip()
    api_region = input("Region [cn/us/eu/in] (eu for Norway): ").strip() or "eu"
    app_uid    = input("Your Smart Life / Tuya App account UID (optional, press Enter to skip): ").strip()

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

    print(f"\nCloud returned {len(devices)} device(s):")
    for d in devices:
        dev_id = d.get("id", "")
        marker = "  ← ECOSO" if dev_id in TARGET_IDS else ""
        print(f"  {dev_id}  {d.get('name', '(no name)')}  key={d.get('key', '??')}{marker}")

    # ── patch devices.json ────────────────────────────────────────────────────
    key_map = {d["id"]: d.get("key", "") for d in devices if d.get("key")}
    found   = {did for did in TARGET_IDS if key_map.get(did)}

    if not found:
        print("\nNo local_keys found for the ECOSO devices in this cloud account.")
        print("See README.md § 'Non-standard OEM cloud' for next steps.")
        return

    devices_cfg = json.loads(DEVICES_FILE.read_text())
    updated = 0
    for dev in devices_cfg["devices"]:
        if dev["id"] in key_map:
            dev["key"] = key_map[dev["id"]]
            updated += 1

    DEVICES_FILE.write_text(json.dumps(devices_cfg, indent=2))
    print(f"\n✓ Updated {updated} device(s) in devices.json with local_keys.")
    print("  You can now run: npx ts-node src/index.ts discover")


if __name__ == "__main__":
    run_wizard()
