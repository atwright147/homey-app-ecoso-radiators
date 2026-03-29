# ECOSO Rads — Homey App

Homey Pro app for controlling **ECOSO Torr** hardwired electric panel heaters over the local LAN using the Tuya protocol. No cloud dependency at runtime.

---

## Features

- Power on / off
- Set target temperature (5–35 °C)
- Switch between Low and High power modes
- Live room temperature reading
- 30-second automatic polling

---

## Requirements

- Homey Pro (Early 2023 or later) — `platforms: ["local"]` only
- ECOSO Torr heaters connected to your Wi-Fi network
- Device ID, IP address, and local encryption key for each heater (see below)

---

## Device credentials

Credentials live in `devices.json` (gitignored). Format:

```json
{
  "devices": [
    {
      "name": "ECOSO Torr 1",
      "id": "<tuya-device-id>",
      "ip": "192.168.0.x",
      "key": "<16-char-local-key>",
      "version": "3.4"
    }
  ]
}
```

To obtain the `local_key` values, use tinytuya:

```sh
npm run scan        # discover devices on the LAN
npm run get-keys    # fetch keys from the Tuya cloud API
```

Alternatively, use mitmproxy to intercept them from the ECOSO mobile app — see the original setup notes in git history.

> Assign static DHCP leases for both device MACs in your router so IPs don't change.

---

## Project structure

```
app.ts                  Homey app entry point
app.json                Homey app manifest
drivers/
  ecoso_torr/
    driver.ts           Pairing — returns a placeholder device
    device.ts           Device lifecycle, capabilities, 30s polling
lib/
  heater.ts             EcosoHeater class — all LAN control logic
  scanner.ts            UDP LAN scanner (CLI use only)
src/
  index.ts              CLI test harness (not bundled in Homey app)
devices.json            Local credentials (gitignored)
```

---

## Scripts

```sh
npm run typecheck          # TypeScript type-check with no output
npm run build              # compile TypeScript → .homeybuild/
npm run validate           # validate app manifest at publish level
npm run install:homey      # build + install to Homey Pro (use this for testing)
npm run dev                # homey app run (dev mode — LAN blocked, see note below)
```

### CLI test harness

Controls heaters directly from the terminal — no Homey required.

```sh
npm run cli -- --device 1 state          # read full state
npm run cli -- --device 1 on             # power on
npm run cli -- --device 1 off            # power off
npm run cli -- --device 1 temp 20        # set target temperature
npm run cli -- --device 1 mode high      # set High power mode
npm run cli -- --device 1 discover       # dump raw DP values
```

`--device 2` targets the second heater. Defaults to device 1.

---

## Pairing in Homey

1. Open the Homey app → Devices → Add Device → ECOSO Torr
2. A placeholder device appears — add it
3. Open the device's Settings and enter:
   - **Device ID** — from `devices.json` (`id`)
   - **IP Address** — from `devices.json` (`ip`)
   - **Local Key** — from `devices.json` (`key`)
4. Save — the device will come online and start reporting temperature

Repeat for the second heater.

---

## Development notes

### `homey app run` vs `homey app install`

`homey app run` runs in a Podman bridge container (`10.88.0.0/16`) that **blocks all outbound TCP to private LAN addresses** (192.168.x.x). Any connection attempt to a local device will get `ECONNREFUSED` immediately. External HTTPS still works.

`homey app install` (production mode) has full LAN access. **Always use `npm run install:homey` when testing device communication.**

### Tuya protocol v3.4

- A fresh `TuyAPI` instance is created per call — reusing a disconnected instance causes reconnect failures
- `device.find()` is skipped when the IP is known — it uses UDP broadcasts which don't work in containers
- Set commands use `shouldWaitForResponse: false`; state is read back after 1.2 s

### DP map

| DP | Name         | Type    | Notes                  |
|----|--------------|---------|------------------------|
| 1  | Switch       | boolean | Power on/off           |
| 2  | Lock         | boolean | Child lock             |
| 3  | Temp_set     | integer | Target °C (5–35)       |
| 4  | Temp_current | integer | Room °C (read-only)    |
| 5  | Timer        | integer | Countdown (minutes)    |
| 6  | FAULT        | bitmap  | Fault flags (read-only)|
| 7  | Mode         | enum    | `"Low"` / `"High"`     |


