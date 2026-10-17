# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. Read this
before changing anything. It captures knowledge that is expensive to rediscover —
especially the two failure modes that caused most of this project's pain.

---

## 1. What this is

A **Homey Pro** app (`com.ecoso.rads`, SDK v3, `platforms: ["local"]`) that controls
two **ECOSO Torr** electric panel heaters over the **local LAN only**, speaking the
Tuya v3.4 protocol directly. There is **no cloud dependency at runtime**.

- Language: TypeScript (CommonJS), compiled by the Homey CLI.
- Tuya access: [`tuyapi`](https://github.com/codetheweb/tuyapi) **7.7.1, locally patched** — see §6.
- Homey CLI: v4.x (`homey`), Homey Pro software 13.x.

The heaters are deliberately **blocked from the internet** by a router firewall
rule. Any solution that depends on the Tuya cloud will not work — do not introduce one.

---

## 2. Hard rules — read these first

1. **Never commit, echo, or paste secrets.** See §7 for the full list. `git status`
   must never show them (they are gitignored).
2. **Never let a secret into the packed app bundle.** The bundle is publishable, and
   there is a non-obvious TypeScript trap that can put secrets in it. See §7.
3. **Do not churn the Tuya session.** One long-lived connection per heater. Do not
   open a connection per operation, and do not add retry loops. See §5.
4. **Do not change `lib/heater.ts`'s connection model casually.** It exists to avoid
   a hardware wedge that requires physical access to clear.
5. **Always finish a dev cycle with `homey app install`.** Both `homey app run`
   variants *uninstall* the app when they exit. See §4.
6. **Follow the workflow: change → `npm run typecheck` → commit → check → deploy.**
7. **Do not force-push.** The history was rewritten once to remove sensitive data;
   verify remote state before any history operation. See §10.

---

## 3. Repository layout

```
app.ts                          Homey app entry point (registers the mode Flow action)
app.json                        Full manifest: app id, capabilities, DRIVER definition, settings
tsconfig.json                   Build config used by the Homey CLI (app files only)
tsconfig.cli.json               Type-check-only config for the dev CLI (src/)
drivers/ecoso_torr/
  driver.ts                     Pairing — returns a single placeholder device
  device.ts                     Device lifecycle: capabilities, events, 120 s poll, readback
lib/
  heater.ts                     EcosoHeater — ALL Tuya/LAN logic lives here
  scanner.ts                    UDP LAN discovery (CLI use only, not used by the app)
src/
  index.ts                      Terminal CLI test harness (dev only, never bundled)
patches/
  tuyapi+7.7.1.patch            patch-package patch for the tuyapi bug (§6)
.homeyignore                    What is excluded from the packed app bundle
devices.json                    Local credentials — gitignored, NOT committed
```

Notable: **there are no `*.compose.json` files.** The whole Homey manifest
(including the driver definition and its settings) is the single root `app.json`.

Capabilities exposed: `onoff`, `target_temperature` (5–35 °C, step 1),
`measure_temperature`, `ecoso_mode` (`Low`/`High`, custom enum), `locked`.
A Flow action `set_mode` maps to the `ecoso_mode` listener.

---

## 4. Commands and the deployment traps

```sh
npm run typecheck     # tsc --noEmit (app)  +  tsc -p tsconfig.cli.json (CLI)
npm run build         # compile the app into .homeybuild/
npm run validate      # homey app validate --level publish
npm run homey:install # build + install to the Homey (production)  ← use this
npm run dev           # homey app run (local container) — see trap below
npm run cli -- <cmd>  # terminal harness against the real heaters
npm run scan          # tinytuya UDP scan (needs .venv)
npm run get-keys      # fetch local keys from the Tuya cloud (needs .env)
```

### Trap 1 — `homey app run` is not faithful

| Command | Where it runs | LAN reachable? | Verdict |
|---|---|---|---|
| `homey app run` | Docker/Podman container on this Mac | **No / unreliable** | Do not trust device results |
| `homey app run --remote` | **On the Homey itself** | Yes | Faithful — use for live logs |
| `homey app install` | On the Homey | Yes | Production install |

Inside the container a TCP connection to the device port may *appear* to connect
and then the Tuya v3.4 handshake stalls or the socket resets. A failure there says
**nothing** about the device, the IP, or the local key. Older notes claim an
immediate `ECONNREFUSED`; the observed behaviour is a stalled/reset handshake —
either way, the container is not a valid test of device connectivity.

To get real logs, use `homey app run --remote` (runs on the Homey):

```sh
homey app run --remote          # Ctrl-C to stop
```

### Trap 2 — both `run` modes uninstall the app on exit

`homey app run` and `homey app run --remote` call the devkit `stopApp` on exit,
which **uninstalls** the app. If you use them, you must finish with:

```sh
homey app install
```

Otherwise the heaters silently disappear from Homey. `homey app install` also
prints the app id you can filter logs by.

---

## 5. The Tuya v3.4 "wedge" — the project's core failure mode

**Symptom:** heaters are pingable and their TCP port is open, but every local
connection is rejected with Tuya error **914** ("check device key or version")
even though the key and version are correct. The Homey app shows them as
unavailable, and it does not recover on its own.

**Cause:** these v3.4 devices tolerate only limited local *session churn* —
opening a fresh TCP connection (a full key negotiation) for every read/write, or
retrying aggressively, eventually makes the device start resetting every
handshake.

**Recovery:** **physically power-cycle the heater** (mains off/on). There is no
software fix once it is wedged. The wedge survives app restarts and Homey reboots.

**Prevention** is the entire point of the current design in `lib/heater.ts`:

- **One long-lived `TuyAPI` session per heater**, reused for every operation.
- **Single-flight `connect()`** — concurrent callers share one negotiation.
- **Exponential backoff** after failures: 15 s, 30 s, 60 s … capped at 5 min.
- **Timeouts**: 10 s connect, 8 s per operation.
- **No per-call reconnect**, and state is driven by the device's **pushed**
  packets (`data` / `dp-refresh` events) rather than aggressive polling.
- The Homey driver polls only every **120 s** as a safety net and does a one-shot
  readback after a write.

> Historical note: the app previously created a `TuyAPI` instance per operation and
> polled every 30 s. That churn is what wedged the heaters. Do not go back to it.

### Where to look when a heater is unavailable

1. Try the CLI: `npm run cli -- --device 1 state`. If it also fails, it is not the app.
2. If it fails with key/version errors while the device pings, suspect **the wedge** → power-cycle.
3. Check the IP: leases are reserved statically in the router, but a moved lease breaks the setting.
4. Check the backoff: after repeated failures the client waits up to 5 min before retrying. Logs say so
   (`backing off for another Ns`).

---

## 6. `tuyapi` is patched — do not lose the patch

**Bug:** tuyapi only advances its outgoing sequence counter (`_currentSequenceN`)
when *it* sends a packet. Tuya devices also advance their own counter for
**unsolicited** packets — notably the `STATUS`/`DP_REFRESH` push sent right after a
`SET`. After that push the client's next request reuses a consumed sequence number,
the device replies on a different one, no resolver matches, and the pending
`get()`/`set()` **hangs** (until the socket is recycled).

Observed trace on a v3.4 heater:

```
connect -> _currentSequenceN = 53896
SET     -> request seq 53897 ; device acks seq 53897
push    -> device sends STATUS seq 53898 ; client counter stays 53897
GET     -> request seq 53898 ; device replies seq 53899 -> no match -> HANG
```

Effect here: the post-write readback always timed out, which dropped the shared
session and backed off after **every** capability change.

**Fix:** re-sync `_currentSequenceN` from every received packet in
`_packetHandler()` (forward-only, so it stays monotonic; safe for the session-key
handshake because the `SESS_KEY_NEG_RES` branch still rebases with `sequenceN - 1`).

**How it is applied:** `patches/tuyapi+7.7.1.patch` + a `postinstall: patch-package`
script. It is re-applied automatically by `npm install`. If you ever see
`get()` hang after a `set()`, first check the patch is present:

```sh
grep -n "Keep our outgoing sequence counter" node_modules/tuyapi/index.js
npm run postinstall            # force re-apply if missing
```

**Upstream:** proposed as codetheweb/tuyapi **PR #709**. If it is merged and
released, upgrade `tuyapi`, delete `patches/tuyapi+7.7.1.patch`, and remove the
`postinstall` script. Related upstream PR: #707 (leaked `get()` resolvers).

> The patch is applied to `node_modules/`, which the Homey CLI copies into the
> bundle — so the fix ships with the app. It is also why the build must run after
> `npm install`.

---

## 7. Secrets — and the bundle trap that leaked them

### Sensitive files (gitignored — never commit, never paste anywhere)

| File | Contains |
|---|---|
| `devices.json` | Tuya device IDs, LAN IPs, **per-device local keys** |
| `.env` | Tuya IoT cloud credentials, optional account UID |
| `OPENCODE-LOCAL.md` | Private local-only device details for agents |
| `snapshot.json`, `tinytuya.json` | Scanner/cloud output that may include identifiers |

Do not copy their contents, or raw chat transcripts, into commits, issues, PRs,
prompts, or docs. The Python scripts can print credentials — redact output before sharing.

**These files are backed up in the user's password manager.** If `devices.json` or
`.env` are missing (fresh clone, new machine), ask the user to restore them from
there — do not fetch, guess or regenerate keys, and never ask for the values to be
pasted into a chat. The committed `.env.example` documents the variable names only.

### The trap (this actually happened)

`tsconfig.json` sets `"outDir": ".homeybuild"`. The Homey CLI packs the app by
**tarring `.homeybuild/`**, and its tar filter only skips dotfiles. Consequences:

- `.homeyignore` filters only the **source copy** into `.homeybuild/`.
- **Anything `tsc` emits into `.homeybuild/` bypasses `.homeyignore` completely.**

`src/index.ts` is part of the build (`tsconfig.json` include) and previously did
`import devicesJson from '../devices.json'`. With `resolveJsonModule`, `tsc`
**emitted `devices.json` into `.homeybuild/`**, so the app archive — installable
and publishable — shipped the heaters' **local encryption keys**.

Fixes applied:

- `tsconfig.json` now includes only the app (`app.ts`, `lib/`, `drivers/`); the CLI
  lives in `tsconfig.cli.json` (type-check only, `noEmit`).
- `src/index.ts` reads `devices.json` at **runtime** (`fs.readFileSync`) and never imports it.
- `.homeyignore` excludes docs, `*.py`/`*.pyc`/`__pycache__/`, `patches/`, `tsconfig*.json`.

### Verify before installing or publishing

```sh
rm -rf .homeybuild && homey app install
find .homeybuild -type f -not -path "*/node_modules/*" | sort
```

The list must contain **only** app runtime files (`app.js`, `app.json`, `assets/`,
`drivers/**/*.js`, `lib/*.js`, `locales/`, `package.json`, `package-lock.json`) and
must **not** contain `devices.json`, `.env`, `*.md`, `*.py`, `__pycache__/`, `src/`,
or `patches/`. `npm run validate --level publish` runs too, but it does **not** check
this — do the `find` yourself.

> If you ever add a JSON import to `app.ts`, `lib/`, or `drivers/`, you re-open this
> hole. Read JSON at runtime instead.

---

## 8. Testing against real hardware

There are **no automated hardware/integration tests**. The testable surface is:

```sh
npm run typecheck
npm run validate
```

…and then the real heaters, via the CLI (which uses the patched `lib/heater.ts`
directly — no Homey involved):

```sh
npm run cli -- --device 1 state        # read state
npm run cli -- --device 1 temp 21      # set target
npm run cli -- --device 1 mode high    # Low / High
npm run cli -- --device 1 on           # power on / off
npm run cli -- lock                    # child lock (unlock to clear)
npm run cli -- --device 1 discover     # dump raw DP values
```

`--device 2` selects the second heater; omitting it targets both. The CLI needs
`devices.json` present (it errors clearly if missing).

For app-level verification, use `homey app run --remote` and watch for
`Heater session established` per device — then finish with `homey app install`.

**Do not** use temperature writes as throwaway tests on the real heaters; use a
no-op write (e.g. setting the current value) when exercising the write path.

### Python utilities

`.venv/` holds the local Python environment — in fish, activate it with
`source .venv/bin/activate.fish`. These scripts are dev-only and never bundled:

| Script | Purpose |
|---|---|
| `get-keys.py` | fetch each device's local key from the Tuya cloud API and write it into `devices.json` |
| `debug-cloud.py` | inspect cloud-side device details |
| `test-connect.py` | probe the heaters across protocol versions using `devices.json` |
| `mitm-keys.py` | helper used when recovering keys from the phone app via mitmproxy |

They can print credentials or device identifiers — redact output before sharing.
`get-keys.py` and `debug-cloud.py` read `.env` (see `.env.example`); `get-keys.py`
output is sensitive because it writes real keys into `devices.json`.

---

## 9. Homey device configuration and the MCP

Device settings are entered **manually** in the Homey app (device ⋯ → Settings):
**Device ID**, **IP Address**, **Local Key**, **Protocol Version** (`3.4`).

The available Homey MCP tools can list homeys/zones, rename and move devices, set
moods, read/start flows — but they **cannot set device capability values or device
settings**. There is no tool-based way to type a key in; it must be done in the app
UI. Plan verification around that limitation.

Pairing always creates a single placeholder device ("ECOSO Torr"); you then fill in
its settings. Add it once per heater.

---

## 10. History, provenance, and safety

- The git history was **rewritten once** to remove sensitive data (device
  identifiers / LAN addresses). Do not force-push, and do not assume that other
  forks, clones, backups, or remotes are clean. Verify before claiming anything is purged.
- Rotate any credential that was exposed outside trusted local storage.
- The Tuya UDP discovery key (`MD5("yGAdlopoPVldABfn")`, in `lib/scanner.ts`) is
  **public protocol material**, not a per-device secret.
- `find-rads-mac.py` (a temporary MAC-lookup helper) is **not** in this checkout.

---

## 11. Conventions

- TypeScript, `strict`, 2-space indent, single quotes, trailing commas.
- All Tuya protocol logic belongs in `lib/heater.ts`. `device.ts` maps Homey
  capabilities to it and owns polling; `driver.ts` owns pairing.
- State flows one way: the device pushes → `EcosoHeater` emits `state` → `device.ts`
  applies it. Only apply non-null fields so partial (`dp-refresh`) updates are safe.
- Keep the bundle lean: anything that is not needed at runtime belongs in
  `.homeyignore` (and remember §7 for `tsc`-emitted files).
- Prefer `npm run cli --` for protocol experiments; keep the app code boring.

---

## 12. Background, decisions and history

Durable context from the original build sessions. The full narrative lived in
`HANDOVER.md`, which has been removed — this is the part worth keeping.

**Decisions already made (do not relitigate without cause):**

- **Manual credential entry beats LAN-discovery pairing.** Interactive pairing via
  the scanner/browser was tried and proved unreliable (pairing flow and container
  networking), so pairing deliberately creates one placeholder device and the real
  ID / IP / key / version are typed into device settings. See §9.
- **`tsx` runs the CLI** (`npm run cli --`); there is no build step for it.
- **Timer and weekly scheduling are intentionally not exposed.** DPs 5 (Timer) and
  6 (FAULT) are read but not surfaced as capabilities.
- **Homey capability labels** are "Power" and "Lock State".

**Notable episodes:**

| Date | What happened |
|---|---|
| 2026-03-27 | Started: two ECOSO Torr heaters, LAN-only goal. Mapped the data points; chose a local-platform Homey app with a placeholder device and manual credential entry. |
| 2026-04-04 | First "reachable but unavailable" investigation: Tuya error **914** with an unchanged key, no root cause found at the time. Later understood as the session-churn wedge (§5). |
| 2026-04-09 | History rewrite to strip device identifiers and LAN addresses from the public repo; concluded no per-device local keys were in tracked history. See the caveats in §10. |
| 2026-04-15 | MAC lookup (`find-rads-mac.py`, not in this checkout) led to static DHCP reservations; a power-cycle was needed for the new lease to take effect. |
| 2026-10-17 | Root-caused the wedge: the per-operation connection model was the cause. Rewrote `lib/heater.ts` around one long-lived session, patched the `tuyapi` sequence bug, and reconciled the docs into this file and `README.md`. |

Connectivity was left unverified in the 2026-04-04 session; that is long since
resolved — both heaters run on the persistent-session client.

---

## 13. Open items

1. Upstream `tuyapi` **PR #709** is open — if merged, drop the local patch (§6).
2. The upstream fork's linter (`xo` 0.25.4) crashes on Node 24 (`util.isDate`). Lint
   the *other* repo later; it does not affect this one.
3. No automated hardware tests — the CLI + `homey app run --remote` is the loop.
4. `README.md`'s "fault/timer DPs are not exposed" still holds; add them only if needed.
