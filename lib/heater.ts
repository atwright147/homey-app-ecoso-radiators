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
 *
 * ── Connection model ─────────────────────────────────────────────────────────
 * Tuya protocol 3.4 devices only tolerate a limited amount of local session
 * churn. Opening a fresh TCP connection (which for 3.4 means a full key
 * negotiation) for every single read/write, or retrying failed commands
 * aggressively, eventually makes the device start rejecting *all* local
 * connections — it resets the session during the key handshake, so every client
 * then sees "check device key or version" (Tuya error 914) despite a correct
 * key, until the heater is physically power-cycled. This is a known, device-class
 * wide issue: see make-all/tuya-local issue #5347.
 *
 * To stay well inside the device's tolerance this class:
 *   - keeps ONE long-lived Tuya session per heater and reuses it for every read
 *     and write (no connect/disconnect per call);
 *   - never runs more than one connection attempt at a time;
 *   - waits out an exponential backoff after a failure instead of hammering;
 *   - surfaces state changes the device pushes (STATUS / DP_REFRESH packets)
 *     rather than polling aggressively.
 */

import { EventEmitter } from 'events';
import TuyAPI from 'tuyapi';
import type { DPSObject, TuyaDeviceOptions } from 'tuyapi';

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

// ── Connection tuning ────────────────────────────────────────────────────────
// Deliberately gentle — see the connection model above.
const CONNECT_TIMEOUT_MS = 10_000;   // TCP connect + v3.4 key negotiation
const OPERATION_TIMEOUT_MS = 8_000;  // a single read/write
const BASE_BACKOFF_MS = 15_000;      // start backing off after the first failure
const MAX_BACKOFF_MS = 5 * 60_000;   // cap retry interval at 5 minutes

/**
 * Raised when an operation got no answer in time. This is NOT the same as a
 * connection failure: the socket is normally still healthy, the request just
 * went unanswered. It is a distinct type so `run()` can tell the two apart and
 * keep the session instead of recycling it (see the note there).
 */
export class HeaterTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeaterTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new HeaterTimeoutError(`${label} timed out after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: Error) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── EcosoHeater class ────────────────────────────────────────────────────────

export class EcosoHeater extends EventEmitter {
  public readonly name: string;
  private readonly opts: TuyaDeviceOptions;

  private device: TuyAPI | null = null;
  private connectInFlight: Promise<TuyAPI> | null = null;
  private failureCount = 0;
  private nextAttemptAt = 0;
  private timeoutStreak = 0;
  private closed = false;

  constructor(config: HeaterConfig) {
    super();
    this.name = config.name;

    this.opts = {
      id: config.id,
      key: config.key,
      ip: config.ip,
      version: (config.version ?? '3.4') as TuyaDeviceOptions['version'],
      issueGetOnConnect: false,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** True while a live session is established. */
  isConnected(): boolean {
    return this.device?.isConnected() ?? false;
  }

  /**
   * Close the session and stop all further activity. Safe to call more than once.
   * Always call this when discarding the instance so the socket and the internal
   * heartbeat timer are released.
   */
  close(): void {
    this.closed = true;
    this.removeAllListeners();
    this.dropDevice();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Read current heater state. Reuses the existing session (connecting once if
   * needed). Emits `state` when the device pushes an update; callers that need a
   * fresh value use the returned object.
   */
  async getState(): Promise<HeaterState> {
    return this.run(async (device) => {
      const result = await device.get({ schema: true }) as { dps?: Record<string, unknown> };
      return parseState(result?.dps ?? {});
    });
  }

  /** Dump ALL raw DP values — useful for schema discovery. */
  async discoverDps(): Promise<Record<string, unknown>> {
    return this.run(async (device) => {
      const result = await device.get({ schema: true }) as { dps?: Record<string, unknown> };
      return result?.dps ?? {};
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

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Send a DP value on the shared session, fire-and-forget.
   * The device does not reliably echo a usable response after `set`, so the new
   * state is picked up from the STATUS packet it pushes (handled in
   * `handleData`) or by a subsequent `getState()`.
   */
  private async setDp(dp: number, value: string | number | boolean): Promise<void> {
    await this.run(async (device) => {
      await device.set({ dps: dp, set: value, shouldWaitForResponse: false });
    });
  }

  /**
   * Ensure a live session, run `fn` against it with a timeout, and keep the
   * session for next time.
   *
   * A *timeout* is deliberately treated as a soft failure. A request can go
   * unanswered even though the socket is perfectly healthy: these v3.4 devices
   * number their replies from their own counter, so a reply can arrive on a
   * sequence number we did not expect — or not arrive at all if the device is
   * being pushed hard. That is not a reason to recycle the connection, and doing
   * so is exactly the connection churn that wedges these heaters (see the
   * connection model at the top of this file). The client re-syncs its sequence
   * counter from the next packet the device sends, so the session recovers on
   * its own.
   *
   * Two unanswered operations in a row is a different story, and is treated as
   * a real failure (drop the socket, start the backoff).
   */
  private async run<T>(fn: (device: TuyAPI) => Promise<T>): Promise<T> {
    const device = await this.connect();
    try {
      const result = await withTimeout(
        fn(device),
        OPERATION_TIMEOUT_MS,
        `[${this.name}] device operation`,
      );
      this.noteSuccess();
      return result;
    } catch (err) {
      if (err instanceof HeaterTimeoutError && ++this.timeoutStreak < 2) {
        this.emit('operation-timeout', err);
        throw err;
      }
      this.noteFailure();
      this.dropDevice();
      throw err;
    }
  }

  /**
   * Establish (or reuse) a single session, honouring backoff. Never opens more
   * than one socket at a time, even under concurrent callers.
   */
  private async connect(): Promise<TuyAPI> {
    if (this.closed) throw new Error(`[${this.name}] heater is closed`);
    if (this.device?.isConnected()) return this.device;
    if (this.connectInFlight) return this.connectInFlight;

    // A retained-but-dead socket is useless; drop it before reconnecting.
    if (this.device) this.dropDevice();

    const waitMs = this.nextAttemptAt - Date.now();
    if (waitMs > 0) {
      throw new Error(`[${this.name}] backing off for another ${Math.ceil(waitMs / 1000)}s`);
    }

    this.connectInFlight = this.openSession();
    try {
      return await this.connectInFlight;
    } finally {
      this.connectInFlight = null;
    }
  }

  private async openSession(): Promise<TuyAPI> {
    const device = new TuyAPI(this.opts);

    device.on('data', (payload: DPSObject) => this.handleData(payload));
    device.on('dp-refresh', (payload: DPSObject) => this.handleData(payload));
    // Must always have an 'error' listener: the socket emits 'error' on a reset.
    // The failure is surfaced through the rejected operation instead.
    device.on('error', () => { /* handled via failed operations */ });
    device.on('disconnected', () => this.handleDisconnect(device));

    try {
      await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, `[${this.name}] connect`);
    } catch (err) {
      try {
        device.removeAllListeners();
        device.disconnect();
      } catch { /* ignore */ }
      this.noteFailure();
      throw err;
    }

    // If close() was called while we were negotiating, discard the new socket
    // rather than leaking a live connection and its heartbeat timer.
    if (this.closed) {
      try {
        device.removeAllListeners();
        device.disconnect();
      } catch { /* ignore */ }
      throw new Error(`[${this.name}] heater is closed`);
    }

    this.device = device;
    this.noteSuccess();
    this.emit('connected');
    return device;
  }

  /** Forward state the device pushed (full STATUS or partial DP_REFRESH). */
  private handleData(payload: DPSObject): void {
    const dps = (payload as { dps?: Record<string, unknown> } | null)?.dps;
    if (!dps) return;
    this.emit('state', parseState(dps));
  }

  private handleDisconnect(device: TuyAPI): void {
    if (this.device !== device) return;
    this.dropDevice();
    if (this.closed) return;
    // The next operation (or poll) will reconnect subject to the backoff.
    this.noteFailure();
  }

  /** Tear down the current socket and release its listeners. */
  private dropDevice(): void {
    const device = this.device;
    this.device = null;
    if (!device) return;
    try { device.removeAllListeners(); } catch { /* ignore */ }
    try { device.disconnect(); } catch { /* ignore */ }
  }

  private noteSuccess(): void {
    this.failureCount = 0;
    this.nextAttemptAt = 0;
    this.timeoutStreak = 0;
  }

  private noteFailure(): void {
    this.failureCount = Math.min(this.failureCount + 1, 12);
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.failureCount - 1));
    this.nextAttemptAt = Date.now() + delay;
    this.emit('unavailable', delay);
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
