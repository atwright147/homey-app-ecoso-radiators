/**
 * index.ts — CLI demo for ECOSO Torr local control
 *
 * Usage (after filling in local keys in devices.json):
 *
 *   # Discover raw DPs (always run this first):
 *   npx ts-node src/index.ts discover
 *
 *   # Read current state:
 *   npx ts-node src/index.ts state
 *
 *   # Turn on / off:
 *   npx ts-node src/index.ts on
 *   npx ts-node src/index.ts off
 *
 *   # Set target temperature (°C):
 *   npx ts-node src/index.ts temp 21.5
 */

import { EcosoHeater, HeaterConfig } from './heater';
import devicesJson from '../devices.json';

// ── Build heater instances from devices.json ──────────────────────────────────

const heaters: EcosoHeater[] = (devicesJson.devices as HeaterConfig[]).map(
  (cfg) => new EcosoHeater(cfg),
);

// ── CLI dispatch ──────────────────────────────────────────────────────────────

const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {

    case 'state': {
      for (const h of heaters) {
        console.log(`\n── ${h.name} ──`);
        const state = await h.getState();
        console.log(`  Power        : ${state.power ?? 'unknown'}`);
        console.log(`  Mode         : ${state.mode ?? 'unknown'}`);
        console.log(`  Target temp  : ${state.targetTempC != null ? state.targetTempC + ' °C' : 'unknown'}`);
        console.log(`  Current temp : ${state.currentTempC != null ? state.currentTempC + ' °C' : 'not reported'}`);
        console.log(`  Child lock   : ${state.childLock ?? 'unknown'}`);
      }
      break;
    }

    case 'on':
    case 'off': {
      const power = command === 'on';
      for (const h of heaters) {
        console.log(`Turning ${command} ${h.name}…`);
        await h.setPower(power);
        console.log(`  Done.`);
      }
      break;
    }

    case 'temp': {
      const tempC = parseFloat(args[0] ?? '');
      if (Number.isNaN(tempC)) {
        console.error('Usage: npx ts-node src/index.ts temp <degrees>');
        process.exit(1);
      }
      for (const h of heaters) {
        console.log(`Setting ${h.name} → ${tempC} °C…`);
        await h.setTargetTemp(tempC);
        console.log(`  Done.`);
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

    default: {
      console.error(`
ECOSO Torr local control — commands:
  state       Read current state from both heaters
  on / off    Power both heaters on or off
  temp <°C>   Set target temperature on both heaters
  discover    Dump raw DP map (schema discovery)

Run one heater at a time by editing the devices array in index.ts.
`);
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  console.error('Error:', err);
  process.exit(1);
});
