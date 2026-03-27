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
 *   npx ts-node src/index.ts state
 *   npx ts-node src/index.ts --device 1 temp 20
 *   npx ts-node src/index.ts --device 2 mode high
 *   npx ts-node src/index.ts lock
 */

import { EcosoHeater, HeaterConfig, HeaterMode } from './heater';
import devicesJson from '../devices.json';

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

const allHeaters: EcosoHeater[] = (devicesJson.devices as HeaterConfig[]).map(
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

  npx ts-node src/index.ts [--device 1|2] <command> [args]

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

main().catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
