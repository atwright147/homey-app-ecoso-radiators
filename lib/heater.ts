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
  private readonly opts: TuyaDeviceOptions;

  constructor(config: HeaterConfig) {
    this.name = config.name;

    this.opts = {
      id: config.id,
      key: config.key,
      ip: config.ip,
      version: (config.version ?? '3.4') as TuyaDeviceOptions['version'],
      issueGetOnConnect: false,
    };
  }

  // ── Connection helpers ─────────────────────────────────────────────────────

  /**
   * Create a fresh TuyAPI instance per call — reusing a disconnected instance
   * across calls causes reconnect failures on v3.4 devices.
   */
  private makeDevice(): TuyAPI {
    return new TuyAPI(this.opts);
  }

  /**
   * Connect, run `fn`, then disconnect. Returns whatever `fn` resolves to.
   * For set operations: listener is NOT needed — set() returns a promise.
   * Skips find() when IP is already provided — find() uses UDP broadcasts
   * which don't work in container environments (e.g. Homey Docker).
   */
  async withConnection<T>(fn: (device: TuyAPI) => Promise<T>): Promise<T> {
    const device = this.makeDevice();
    const onError = (_err: Error) => {};
    (device as unknown as import('events').EventEmitter).on('error', onError);
    if (!this.opts.ip) {
      await device.find();
    }
    await device.connect();
    try {
      return await fn(device);
    } finally {
      (device as unknown as import('events').EventEmitter).off('error', onError);
      await device.disconnect();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Read current heater state (standalone, no preceding set).
   * get() can fire immediately — no STATUS echo in flight.
   */
  async getState(): Promise<HeaterState> {
    return this.withConnection(async (device) => {
      const result = await device.get({ schema: true }) as { dps: Record<string, unknown> };
      return parseState(result?.dps ?? {});
    });
  }

  /**
   * Send a DP value (fire-and-forget on its own connection).
   * The device does not reliably echo a usable response after set —
   * tuyapi's internal _setResolver swallows the STATUS packet before
   * the data event fires. Use getState() separately after a delay.
   */
  private async setDp(dp: number, value: string | number | boolean): Promise<void> {
    await this.withConnection(async (device) => {
      await device.set({ dps: dp, set: value, shouldWaitForResponse: false });
    });
  }

  /** Turn heater on (true) or off (false). */
  async setPower(on: boolean): Promise<void> {
    await this.setDp(DP.SWITCH, on);
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
    await this.setDp(DP.TEMP_SET, rounded);
  }

  /** Set mode ('Low' or 'High' power). */
  async setMode(mode: HeaterMode): Promise<void> {
    await this.setDp(DP.MODE, mode);
  }

  /** Set child lock. */
  async setChildLock(locked: boolean): Promise<void> {
    await this.setDp(DP.CHILDLOCK, locked);
  }

  /** Dump ALL raw DP values — useful for schema discovery. */
  async discoverDps(): Promise<Record<string, unknown>> {
    return this.withConnection(async (device) => {
      const result = await device.get({ schema: true }) as { dps: Record<string, unknown> };
      return result?.dps ?? {};
    });
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
