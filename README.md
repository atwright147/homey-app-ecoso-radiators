# ECOSO Torr — Local LAN Control

Two ECOSO Torr hardwired electric heaters, controlled locally via the Tuya LAN protocol (v3.4, port 6668). No cloud dependency at runtime once the `local_key` is known.

---

## Part 1 — Scan results

Both devices were found and are responding to Tuya LAN broadcasts:

| Name | Device ID | IP | Protocol |
|---|---|---|---|
| ECOSO Torr 1 | `<tuya-device-id-1>` | `<device-ip-1>` | v3.4 |
| ECOSO Torr 2 | `<tuya-device-id-2>` | `<device-ip-2>` | v3.4 |

Both have `encrypt: true` and `token: true` — they are **actively broadcasting** and **will respond to LAN commands**, but only after you provide the correct `local_key`.

Re-run the scan at any time:
```bash
npm run scan
```

---

## Part 2 — What "v3.4" means for local control

Tuya protocol v3.4 uses a _session-key negotiation_ handshake on every connection (HMAC-SHA256 over a random nonce). `tuyapi` v7+ handles this automatically — you don't need to do anything special; just provide the `local_key` and it works.

---

## Part 3 — Getting the `local_key`

The `local_key` is a 16-character AES key programmed into the device at the factory and also stored in the Tuya cloud against the device's account. There are three paths to obtain it, ordered from easiest to hardest.

### Path A — Standard Tuya IoT Platform (try this first)

1. Go to [iot.tuya.com](https://iot.tuya.com) and create a free developer account.
2. Create a **Cloud Project** → pick any name, select **Smart Home** as the industry, choose the **eu** data centre (you're in Europe/Norway).
3. Go to your project → **Devices** tab → **Link Tuya App Account**.
4. Download **Smart Life** (iOS/Android) and create a new account (or use your existing one).
5. In Smart Life, add your ECOSO heaters using the **+ Add Device** flow. The heaters should appear because they broadcast on the LAN (they don't need to re-pair — if they're already on Wi-Fi they'll show up).
6. In the IoT portal, link your Smart Life account UID. Your devices now appear in the portal.
7. Run the key-extraction helper:
   ```bash
   npm run get-keys
   # or: source .venv/bin/activate && python3 get-keys.py
   ```
   Enter your API Key, API Secret, and region `eu`. The script patches `devices.json` automatically.

> **Why this might not work:** ECOSO uses a Tuya OEM/white-label cloud partition. Devices registered under an OEM partition _cannot_ be claimed by a different app (Smart Life). If step 5 fails (device not found or "already bound to another account"), move to Path B or C.

### Path B — ECOSO OEM portal (if it exists)

Some Tuya OEM brands expose a developer programme. Check:
- [https://developer.ecoso.no](https://developer.ecoso.no) (speculative — check if it exists)
- Contact ECOSO support and ask for your device's `local_key` — quoting your device IDs (`<tuya-device-id-1>` and `<tuya-device-id-2>`)

### Path C — Intercept via mitmproxy (guaranteed to work)

This captures the `local_key` from the ECOSO app's own API calls. It requires ~15 minutes of setup.

#### Setup

```bash
# Install mitmproxy (macOS)
brew install mitmproxy
```

#### Run the interceptor

```bash
mitmdump -s mitm-keys.py --listen-port 8080
```

Your terminal will now show `Proxy server listening at http://*:8080`.

#### Configure your phone

1. Find your Mac's LAN IP: `ipconfig getifaddr en0`
2. On your iPhone/Android: **Settings → Wi-Fi → your network → HTTP Proxy → Manual**
   - Server: `<your Mac IP>`
   - Port: `8080`
3. In Safari/Chrome on the phone, go to `http://mitm.it` and install the mitmproxy CA certificate (follow the platform-specific steps shown on that page).

#### Trigger the ECOSO app

4. Open the **ECOSO** app on your phone.
5. Navigate to each heater — turn it on/off, view its temperature.
6. Watch the terminal on your Mac — `mitm-keys.py` will print and auto-patch `devices.json` as soon as it sees the keys in the API response.

#### Clean up

7. Remove the mitmproxy CA cert from your phone (Settings → General → VPN & Device Management).
8. Restore your Wi-Fi proxy settings to **Off**.

---

## Part 4 — Local control scripts

Once `devices.json` has real `key` values:

```bash
# Discover raw DP map — always do this first to verify DPs match the schema
npm run discover

# Read current state (power, temps, mode)
npm run state

# Power on / off both heaters
npm run on
npm run off

# Set target temperature
npx ts-node src/index.ts temp 21.5
```

### Known DP schema (ECOSO Torr / generic Tuya WiFi thermostat)

| DP | Name | Type | Notes |
|---|---|---|---|
| 1 | `switch` | boolean | Power on/off |
| 2 | `mode` | enum | `"manual"` / `"auto"` / `"holiday"` |
| 3 | `fault_alarm` | bitmap | Read-only fault bits |
| 16 | `temp_set` | integer | Target temp × 10 (e.g. `215` = 21.5 °C) |
| 24 | `temp_current` | integer | Room temp × 10 (read-only) |
| 26 | `temp_correction` | integer | Calibration offset × 10 |
| 27 | `childlock` | boolean | Key lock |

> **If `discover` returns unexpected DP numbers**, the ECOSO firmware may use a different schema. Note the raw values and update `DP` constants in `src/heater.ts` accordingly.

### TypeScript API

```typescript
import { EcosoHeater } from './src/heater';

const heater = new EcosoHeater({
  name:    'Living Room',
  id:      '<tuya-device-id-1>',
  ip:      '<device-ip-1>',
  key:     'your16charkey!!!',
  version: '3.4',
});

const state = await heater.getState();
console.log(state.currentTempC);  // e.g. 19.5

await heater.setPower(true);
await heater.setTargetTemp(21.5);
await heater.setMode('auto');
```

---

## Part 5 — If a device stops responding

Tuya devices get their IPs from DHCP. If a device moves to a new IP:

```bash
npm run scan      # re-detect current IPs
# then update devices.json manually
```

Consider assigning static DHCP leases for both MACs in your router.

---

## File map

```
ecoso-rads/
├── devices.json          ← device IDs, IPs, keys (fill in keys)
├── get-keys.py           ← Path A: pull keys from Tuya IoT cloud
├── mitm-keys.py          ← Path C: mitmproxy interceptor script
├── snapshot.json         ← raw tinytuya scan output
├── src/
│   ├── heater.ts         ← EcosoHeater class (tuyapi wrapper)
│   └── index.ts          ← CLI demo / quick test harness
└── .venv/                ← Python venv with tinytuya
```
