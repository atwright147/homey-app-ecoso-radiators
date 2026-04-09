#!/usr/bin/env python3
"""
debug-cloud.py — Query Tuya cloud for live device status and detailed info.
Reads credentials interactively and device IDs from devices.json.
"""
import json
import os
import tinytuya
from pathlib import Path

# ── load .env if present ─────────────────────────────────────────────────────
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip())

devices_cfg = json.loads(Path("devices.json").read_text())
target_ids = [d["id"] for d in devices_cfg["devices"]]

api_key    = os.environ.get("TUYA_API_KEY") or input("Tuya IoT API Key    : ").strip()
api_secret = os.environ.get("TUYA_API_SECRET") or input("Tuya IoT API Secret : ").strip()
api_region = os.environ.get("TUYA_REGION") or input("Region [cn/us/eu/in] (eu for Norway): ").strip() or "eu"

print(f"Using API key: {api_key}  region: {api_region}")

app_uid = os.environ.get("TUYA_APP_UID") or None

cloud = tinytuya.Cloud(
    apiRegion=api_region,
    apiKey=api_key,
    apiSecret=api_secret,
    apiDeviceID=app_uid if app_uid else None,
    new_sign_algorithm=True,
)

for dev_id in target_ids:
    name = next((d["name"] for d in devices_cfg["devices"] if d["id"] == dev_id), dev_id)
    print(f"\n{'─'*60}")
    print(f"Device: {name}  ({dev_id})")

    # Cloud status (goes via Tuya cloud → device, proves cloud connectivity)
    print("\n  Cloud status (via cloud API):")
    try:
        status = cloud.getstatus(dev_id)
        print(f"    {json.dumps(status, indent=4)}")
    except Exception as e:
        print(f"    ERROR: {e}")

    # Full device details (richer than getdevices())
    print("\n  Device details (extended):")
    try:
        details = cloud.getdevicedetails(dev_id)
        print(f"    {json.dumps(details, indent=4)}")
    except Exception as e:
        print(f"    ERROR: {e}")
