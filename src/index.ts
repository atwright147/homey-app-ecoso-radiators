/**
 * index.ts — CLI test harness for ECOSO Torr local control
 *
 * Target one or both heaters with --device 1 | --device 2 | (omit = both)
 *
 * Commands:
 *   discover                   Dump raw DP map
 *   state                      Read full device state
 *   on                         Power on
 *   off                        Power off
 *   temp <°C>                  Set target temperature  (e.g. temp 21)
 *   mode low|high              Set power mode
 *   lock                       Enable child lock
 *   unlock                     Disable child lock
 *
 * Examples:
 *   npm run cli -- state
 *   npm run cli -- --device 1 temp 20
 *   npm run cli -- --device 2 mode high
 *   npm run cli -- lock
 */

import * as fs from 'fs';
import * as path from 'path';
import { EcosoHeater, HeaterConfig, HeaterMode } from '../lib/heater';

// ── Parse --device flag ───────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let deviceFilter: number | null = null;
const filteredArgv: string[] = [];

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--device' && argv[i + 1]) {
    deviceFilter = parseInt(argv[++i], 10);
  } else {
    filteredArgv.push(argv[i]);
  }
}

const [command, ...args] = filteredArgv;

// ── Build heater instances ────────────────────────────────────────────────────

/**
 * Load device credentials at *runtime*.
 *
 * Deliberately NOT `import devicesJson from '../devices.json'`: importing a JSON
 * module makes `tsc` emit a copy of it into the Homey build directory
 * (`outDir: .homeybuild`), which is then packed into the app archive — leaking
 * the device local keys. Reading it from disk keeps it out of the bundle.
 * See AGENTS.md → "Never ship a secret".
 */
function loadDeviceConfigs(): HeaterConfig[] {
  const file = path.join(__dirname, '..', 'devices.json');

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `Cannot read ${file} — create it with your Tuya device credentials (see README.md → Device credentials)`,
    );
  }

  const parsed = JSON.parse(raw) as { devices?: HeaterConfig[] };
  return parsed.devices ?? [];
}

const allHeaters: EcosoHeater[] = loadDeviceConfigs().map(
  (cfg) => new EcosoHeater(cfg),
);

const heaters =
  deviceFilter != null ? [allHeaters[deviceFilter - 1]].filter(Boolean) : allHeaters;

if (heaters.length === 0) {
  console.error(`No device at index ${deviceFilter}. Available: 1–${allHeaters.length}`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function printState(name: string, s: Awaited<ReturnType<EcosoHeater['getState']>>): void {
  console.log(`\n── ${name} ──`);
  console.log(`  Power        : ${s.power ?? 'unknown'}`);
  console.log(`  Mode         : ${s.mode ?? 'unknown'}`);
  console.log(`  Target temp  : ${s.targetTempC  != null ? s.targetTempC  + ' °C' : 'unknown'}`);
  console.log(`  Current temp : ${s.currentTempC != null ? s.currentTempC + ' °C' : 'unknown'}`);
  console.log(`  Child lock   : ${s.childLock ?? 'unknown'}`);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Delay between set and getState so the device's broadcast clears. */
const READBACK_DELAY_MS = 1000;

function usage(): never {
  console.error(`
ECOSO Torr — test harness

  npm run cli -- [--device 1|2] <command> [args]

Commands:
  discover           Dump raw DP values
  state              Read full state
  on / off           Power on / off
  temp <°C>          Set target temperature
  mode low|high      Set power mode
  lock / unlock      Enable / disable child lock
`);
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  switch (command) {

    case 'state': {
      for (const h of heaters) {
        printState(h.name, await h.getState());
      }
      break;
    }

    case 'on':
    case 'off': {
      for (const h of heaters) {
        console.log(`[${h.name}] turning ${command}…`);
        await h.setPower(command === 'on');
        await sleep(READBACK_DELAY_MS);
        printState(h.name, await h.getState());
      }
      break;
    }

    case 'temp': {
      const tempC = parseFloat(args[0] ?? '');
      if (Number.isNaN(tempC)) {
        console.error('Usage: temp <degrees>  e.g. temp 21');
        process.exit(1);
      }
      for (const h of heaters) {
        console.log(`[${h.name}] setting target → ${Math.round(tempC)} °C…`);
        await h.setTargetTemp(tempC);
        await sleep(READBACK_DELAY_MS);
        printState(h.name, await h.getState());
      }
      break;
    }

    case 'mode': {
      const raw = (args[0] ?? '').toLowerCase();
      if (raw !== 'low' && raw !== 'high') {
        console.error('Usage: mode low|high');
        process.exit(1);
      }
      const mode = (raw.charAt(0).toUpperCase() + raw.slice(1)) as HeaterMode;
      for (const h of heaters) {
        console.log(`[${h.name}] setting mode → ${mode}…`);
        await h.setMode(mode);
        await sleep(READBACK_DELAY_MS);
        printState(h.name, await h.getState());
      }
      break;
    }

    case 'lock':
    case 'unlock': {
      const locked = command === 'lock';
      for (const h of heaters) {
        console.log(`[${h.name}] ${locked ? 'locking' : 'unlocking'}…`);
        await h.setChildLock(locked);
        await sleep(READBACK_DELAY_MS);
        printState(h.name, await h.getState());
      }
      break;
    }

    case 'discover': {
      for (const h of heaters) {
        console.log(`\n── ${h.name} — raw DP dump ──`);
        const dps = await h.discoverDps();
        if (Object.keys(dps).length === 0) {
          console.log('  No DPs reported (is the local_key correct?)');
        } else {
          for (const [dp, val] of Object.entries(dps)) {
            console.log(`  DP ${dp.padStart(3)} = ${JSON.stringify(val)}`);
          }
        }
      }
      break;
    }

    default:
      usage();
  }
}

function shutdown(code: number): void {
  // Sessions are long-lived now, so close them or the process will never exit.
  for (const h of allHeaters) {
    try { h.close(); } catch { /* ignore */ }
  }
  process.exit(code);
}

main().then(
  () => shutdown(0),
  (err: unknown) => {
    console.error('Error:', err instanceof Error ? err.message : err);
    shutdown(1);
  },
);
