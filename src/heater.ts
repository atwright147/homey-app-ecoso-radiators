/**
 * EcosoHeater — local LAN control via tuyapi (Tuya v3.4 protocol)
 *
 * Known DPs for ECOSO Torr / generic Tuya WiFi thermostat:
 *   1  → Switch        (boolean)  power on/off
 *   2  → Lock          (boolean)  child lock
 *   3  → Temp_set      (integer)  target temp in whole °C
 *   4  → Temp_current  (integer)  room temp in whole °C    (read-only)
 *   5  → Timer         (integer)  countdown timer in minutes
 *   6  → FAULT         (bitmap)   fault flags (read-only)
 *   7  → Mode          (enum)     "Low" | "High"
 */

import TuyAPI from 'tuyapi';
import type { TuyaDeviceOptions } from 'tuyapi';
import { EventEmitter } from 'events';

// ── Types ────────────────────────────────────────────────────────────────────

export type HeaterMode = 'Low' | 'High';

export interface HeaterConfig {
  name: string;
  id: string;
  ip: string;
  key: string;
  version?: string;
}

export interface HeaterState {
  power: boolean | null;
  mode: HeaterMode | null;
  targetTempC: number | null;   // whole °C
  currentTempC: number | null;  // whole °C (read-only)
  childLock: boolean | null;
  rawDps: Record<string, unknown>;
}

// ── DP map ───────────────────────────────────────────────────────────────────

const DP = {
  SWITCH: 1,
  CHILDLOCK: 2,
  TEMP_SET: 3,
  TEMP_CURRENT: 4,
  TIMER: 5,
  FAULT: 6,
  MODE: 7,
} as const;

// ── EcosoHeater class ────────────────────────────────────────────────────────

export class EcosoHeater {
  public readonly name: string;
  private device: TuyAPI;
  private emitter: EventEmitter;

  constructor(config: HeaterConfig) {
    this.name = config.name;

    const opts: TuyaDeviceOptions = {
      id: config.id,
      key: config.key,
      ip: config.ip,
      version: (config.version ?? '3.4') as TuyaDeviceOptions['version'],
      issueGetOnConnect: true,
    };

    this.device = new TuyAPI(opts);
    this.emitter = this.device as unknown as EventEmitter;

    // Forward unhandled errors so callers can attach .on('error')
    this.device.on('error', () => { /* swallow — caller listens */ });
  }

  // ── Connection helpers ─────────────────────────────────────────────────────

  /** Connect, run `fn`, then disconnect. Returns whatever `fn` resolves to. */
  async withConnection<T>(fn: (device: TuyAPI) => Promise<T>): Promise<T> {
    await this.device.find();
    await this.device.connect();
    try {
      return await fn(this.device);
    } finally {
      await this.device.disconnect();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Read current heater state in one connection. */
  async getState(): Promise<HeaterState> {
    return this.withConnection(() =>
      new Promise<HeaterState>((resolve, reject) => {
        const tid = setTimeout(() => reject(new Error('Timeout waiting for device data')), 8_000);

        this.emitter.once('data', (rawData: { dps: Record<string, unknown> }) => {
          clearTimeout(tid);
          const dps = rawData?.dps ?? {};
          resolve(parseState(dps));
        });

        this.emitter.once('error', (err: Error) => {
          clearTimeout(tid);
          reject(err);
        });
      }),
    );
  }

  /** Turn heater on (true) or off (false). */
  async setPower(on: boolean): Promise<void> {
    await this.withConnection(async (device) => {
      await device.set({ dps: DP.SWITCH, set: on });
    });
  }

  /**
   * Set target temperature.
   * @param tempC  Target in whole °C, e.g. 21
   */
  async setTargetTemp(tempC: number): Promise<void> {
    const rounded = Math.round(tempC);
    if (rounded < 5 || rounded > 35) {
      throw new RangeError(`Target temperature ${rounded} °C is outside the safe 5–35 °C range`);
    }
    await this.withConnection(async (device) => {
      await device.set({ dps: DP.TEMP_SET, set: rounded });
    });
  }

  /** Set mode ('Low' or 'High' power). */
  async setMode(mode: HeaterMode): Promise<void> {
    await this.withConnection(async (device) => {
      await device.set({ dps: DP.MODE, set: mode });
    });
  }

  /** Set child lock. */
  async setChildLock(locked: boolean): Promise<void> {
    await this.withConnection(async (device) => {
      await device.set({ dps: DP.CHILDLOCK, set: locked });
    });
  }

  /**
   * Dump ALL raw DP values reported by the device — useful for schema discovery
   * when the documented DPs don't match what your device actually sends.
   */
  async discoverDps(): Promise<Record<string, unknown>> {
    return this.withConnection(() =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const accumulated: Record<string, unknown> = {};
        const tid = setTimeout(() => resolve(accumulated), 6_000);

        const onData = (rawData: { dps: Record<string, unknown> }) => {
          Object.assign(accumulated, rawData?.dps ?? {});
        };

        this.emitter.on('data', onData);

        this.emitter.once('error', (err: Error) => {
          clearTimeout(tid);
          this.emitter.off('data', onData);
          reject(err);
        });
      }),
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseState(dps: Record<string, unknown>): HeaterState {
  const raw = (key: number): unknown => dps[String(key)];

  const tempSetRaw = raw(DP.TEMP_SET);
  const tempCurrRaw = raw(DP.TEMP_CURRENT);

  return {
    power:        typeof raw(DP.SWITCH) === 'boolean' ? (raw(DP.SWITCH) as boolean) : null,
    mode:         typeof raw(DP.MODE) === 'string' ? (raw(DP.MODE) as HeaterMode) : null,
    targetTempC:  typeof tempSetRaw  === 'number'     ? tempSetRaw                  : null,
    currentTempC: typeof tempCurrRaw === 'number'     ? tempCurrRaw                 : null,
    childLock:    typeof raw(DP.CHILDLOCK) === 'boolean' ? (raw(DP.CHILDLOCK) as boolean) : null,
    rawDps: dps,
  };
}
