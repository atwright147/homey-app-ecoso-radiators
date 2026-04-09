#!/usr/bin/env python3
"""
mitm-keys.py  —  Extract ECOSO local_keys by intercepting app traffic with mitmproxy

Use this ONLY if get-keys.py fails because the devices are on a non-standard OEM cloud.

Prerequisites
-------------
  pip install mitmproxy          (outside venv, or: .venv/bin/pip install mitmproxy)
  mitmproxy version >= 10

How to use
----------
  1. Run this script with mitmdump:
       mitmdump -s mitm-keys.py --listen-port 8080

  2. On your iPhone/Android, set HTTP proxy to: <your Mac's LAN IP>:8080

  3. Visit http://mitm.it in Safari/Chrome on the phone and install the
     mitmproxy CA certificate (follow on-screen instructions for iOS/Android).

  4. Open the ECOSO app and interact with your heaters (turn on/off, check status).

  5. This script will print device IDs and local_keys as they appear in traffic,
     and auto-patch devices.json.

Security note
-------------
  Remove the mitmproxy CA cert from your phone immediately after use.
  Only run this on a network you control.
"""

import json
import re
import os
from pathlib import Path
from mitmproxy import http

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


TARGET_IDS = load_target_ids()
if not TARGET_IDS:
    raise RuntimeError(
        "No target IDs configured. Add device IDs to local devices.json "
        "or set TARGET_IDS=id1,id2 before running mitmdump."
    )
if not DEVICES_FILE.exists():
    raise RuntimeError(
        "devices.json not found. Create a local ignored devices.json first "
        "so extracted keys can be patched safely."
    )

# Regex patterns for common Tuya API response fields
_KEY_RE    = re.compile(r'"local_key"\s*:\s*"([^"]{16})"')
_ID_RE     = re.compile(r'"id"\s*:\s*"(bf[0-9a-z]{20,22})"')
_DEVID_RE  = re.compile(r'"devId"\s*:\s*"(bf[0-9a-z]{20,22})"')


def response(flow: http.HTTPFlow) -> None:
    """Inspect every HTTPS response for Tuya device/key data."""
    url = flow.request.pretty_url
    body = flow.response.text if flow.response else ""

    if not body:
        return

    found_ids  = set(_ID_RE.findall(body))  | set(_DEVID_RE.findall(body))
    found_keys = _KEY_RE.findall(body)

    if found_ids and found_keys:
        print(f"\n{'='*60}")
        print(f"[mitm-keys] Tuya API hit: {url}")

        # Try to parse as JSON for a cleaner view
        try:
            data = json.loads(body)
            devices_in_body = _find_devices_recursive(data)
            for d in devices_in_body:
                dev_id  = d.get("id") or d.get("devId", "")
                dev_key = d.get("local_key", "")
                if dev_id and dev_key:
                    target = "  ← target device" if dev_id in TARGET_IDS else ""
                    print(f"  id={dev_id}  key={dev_key}{target}")
                    if dev_id in TARGET_IDS:
                        _patch_devices_json(dev_id, dev_key)
        except json.JSONDecodeError:
            # Fall back to regex results
            for i, (dev_id, dev_key) in enumerate(zip(found_ids, found_keys)):
                print(f"  id={dev_id}  key={dev_key}")

        print(f"{'='*60}")


def _find_devices_recursive(obj, _depth=0):
    """Walk arbitrary JSON structure looking for objects that have both id and local_key."""
    if _depth > 10:
        return []
    results = []
    if isinstance(obj, dict):
        if ("id" in obj or "devId" in obj) and "local_key" in obj:
            results.append(obj)
        for v in obj.values():
            results.extend(_find_devices_recursive(v, _depth + 1))
    elif isinstance(obj, list):
        for item in obj:
            results.extend(_find_devices_recursive(item, _depth + 1))
    return results


def _patch_devices_json(dev_id: str, local_key: str) -> None:
    try:
        cfg = json.loads(DEVICES_FILE.read_text())
        patched = False
        for dev in cfg["devices"]:
            if dev["id"] == dev_id and dev.get("key") != local_key:
                dev["key"] = local_key
                patched = True
        if patched:
            DEVICES_FILE.write_text(json.dumps(cfg, indent=2))
            print(f"  ✓ Patched devices.json with key for {dev_id}")
    except Exception as exc:
        print(f"  [warn] Could not patch devices.json: {exc}")
