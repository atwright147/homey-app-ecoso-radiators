#!/usr/bin/env python3
"""Quick connection test — reads credentials from devices.json to avoid shell escaping issues."""
import json
import tinytuya
from pathlib import Path

devices = json.loads(Path("devices.json").read_text())["devices"]

for dev in devices:
    print(f"\nTesting {dev['name']} ({dev['ip']})...")
    for ver in [3.4, 3.5, 3.3]:
        try:
            d = tinytuya.Device(dev["id"], dev["ip"], dev["key"], version=ver)
            d.set_socketTimeout(5)
            result = d.status()
            print(f"  v{ver}: {result}")
            if "Error" not in result:
                print(f"  *** SUCCESS with version {ver} ***")
                break
        except Exception as e:
            print(f"  v{ver}: Exception: {e}")
