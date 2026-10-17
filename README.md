# ECOSO Rads — Homey App

Homey Pro app for controlling **ECOSO Torr** hardwired electric panel heaters over the local LAN using the Tuya protocol. No cloud dependency at runtime.

> Working on this repo (human or AI)? Read **[AGENTS.md](./AGENTS.md)** first — it documents the connection model, the Tuya v3.4 "wedge", the local `tuyapi` patch, and the secrets rules.

---

## Features

- Power on / off
- Set target temperature (5–35 °C)
- Switch between Low and High power modes
- Live room temperature reading
- Child lock
- State pushed by the heater, with a 120-second poll as a safety net

---

## Requirements

- Homey Pro (Early 2023 or later) — `platforms: ["local"]` only
- ECOSO Torr heaters connected to your Wi-Fi network
- Device ID, IP address, and local encryption key for each heater (see below)
- Heaters reachable from the Homey on the LAN (they may be blocked from the internet)

---

## Device credentials

Credentials live in `devices.json` (gitignored — **never commit it**). Format:

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

Cloud credentials used to retrieve those keys live in `.env` (gitignored). Copy
the committed template and fill it in:

```sh
cp .env.example .env
```

> 🔐 **The secrets are not stored in git.** `devices.json` and `.env` are backed up
> in the project owner's password manager. If either file is missing, restore it
> from there — do not try to re-derive the keys.

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
app.ts                  Homey app entry point (mode Flow action)
app.json                Full Homey manifest — app + driver definition + settings
drivers/
  ecoso_torr/
    driver.ts           Pairing — returns a placeholder device
    device.ts           Device lifecycle, capabilities, 120s poll, write readback
lib/
  heater.ts             EcosoHeater class — all LAN control logic
  scanner.ts            UDP LAN scanner (CLI use only)
src/
  index.ts              CLI test harness (dev only, not bundled)
patches/
  tuyapi+7.7.1.patch    Local patch for a tuyapi bug (see AGENTS.md)
devices.json            Local credentials (gitignored)
```

There are no `*.compose.json` files — the entire manifest is the single root `app.json`.

---

## Scripts

```sh
npm run typecheck          # type-check the app and the CLI
npm run build              # compile TypeScript → .homeybuild/
npm run validate           # validate app manifest at publish level
npm run homey:install      # build + install to Homey Pro (use this for testing)
npm run dev                # homey app run (container — not LAN-faithful, see notes)
```

### CLI test harness

Controls heaters directly from the terminal — no Homey required.

```sh
npm run cli -- --device 1 state          # read full state
npm run cli -- --device 1 on             # power on
npm run cli -- --device 1 off            # power off
npm run cli -- --device 1 temp 20        # set target temperature
npm run cli -- --device 1 mode high      # set High power mode
npm run cli -- --device 1 lock           # child lock
npm run cli -- --device 1 discover       # dump raw DP values
```

`--device 2` targets the second heater. Omit it to target both.

---

## Pairing in Homey

1. Open the Homey app → Devices → Add Device → ECOSO Torr
2. A placeholder device appears — add it
3. Open the device's Settings and enter:
   - **Device ID** — from `devices.json` (`id`)
   - **IP Address** — from `devices.json` (`ip`)
   - **Local Key** — from `devices.json` (`key`)
   - **Protocol Version** — `3.4`
4. Save — the device will come online and start reporting temperature

Repeat for the second heater.

---

## Development notes

### Connection model (important)

The heaters do **not** tolerate connection churn. Tuya v3.4 devices that receive a
fresh TCP connection (and key negotiation) per operation will eventually start
rejecting *all* local connections — Tuya error **914** — until they are physically
power-cycled. This is the single most important constraint in the project.

The app therefore keeps **one long-lived Tuya session per heater**, shared by every
read and write, with single-flight connects, operation/connect timeouts, and
exponential backoff (15 s → 5 min). State is driven by packets the device **pushes**;
the 120-second poll is only a safety net. See [AGENTS.md](./AGENTS.md) §5.

### `homey app run` vs `homey app install`

`homey app run` starts the app in a Podman bridge container on your Mac. That
container **cannot reliably reach the private LAN** — a TCP connection to the device
may appear to connect and then the Tuya handshake stalls or resets. A failure there
does **not** mean the device, IP, or key is wrong.

Use one of these instead:

- `homey app run --remote` — runs **on the Homey** (faithful), for live logs
- `npm run homey:install` — permanent production install

Both `run` modes **uninstall the app when they exit**, so finish with
`npm run homey:install`.

### Tuya protocol v3.4 and `tuyapi`

`tuyapi` 7.7.1 has a sequence-counter bug: an unsolicited device packet (such as the
status push after a `SET`) desynchronises the client's counter, after which the next
`get()`/`set()` hangs. These heaters number their replies from their *own* counter
rather than echoing ours, so a reply can also arrive on a sequence number that
collides with a different pending request and be resolved with the wrong payload.
This is patched locally via `patches/tuyapi+7.7.1.patch` (applied automatically by
`postinstall`): the client re-syncs its counter from every received packet, records
each request's command byte, matches query responses by that command byte, and
drops resolvers that will never match. The counter re-sync is reported upstream as
[codetheweb/tuyapi#709](https://github.com/codetheweb/tuyapi/pull/709). Do not remove
the patch until a fixed release exists — see [AGENTS.md](./AGENTS.md) §6.

### Secrets

`devices.json`, `.env`, and `OPENCODE-LOCAL.md` are gitignored and must stay out of
the packed app bundle. Beware: because the TypeScript compiler writes into
`.homeybuild/`, an *imported* JSON file would bypass `.homeyignore` and ship with the
app. Always verify the bundle before publishing — see [AGENTS.md](./AGENTS.md) §7.

### DP map

| DP | Name         | Type    | Notes                  |
|----|--------------|---------|------------------------|
| 1  | Switch       | boolean | Power on/off           |
| 2  | Lock         | boolean | Child lock             |
| 3  | Temp_set     | integer | Target °C (5–35)       |
| 4  | Temp_current | integer | Room °C (read-only)    |
| 5  | Timer        | integer | Countdown (minutes), not exposed |
| 6  | FAULT        | bitmap  | Fault flags (read-only), not exposed |
| 7  | Mode         | enum    | `"Low"` / `"High"`     |
