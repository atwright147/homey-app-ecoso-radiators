import { Device } from 'homey';
import { EcosoHeater } from '../../lib/heater';
import type { HeaterState } from '../../lib/heater';

// State is pushed by the heater on change, so polling is only a safety net.
// Keep it slow: each operation now runs on the shared long-lived session, and
// the device dislikes connection churn (see lib/heater.ts).
const POLL_INTERVAL_MS = 120_000;
const READBACK_DELAY_MS = 2_000;

class EcosoTorrDevice extends Device {
  private heater?: EcosoHeater;
  private pollTimer?: NodeJS.Timeout;
  private readbackTimer?: NodeJS.Timeout;

  async onInit() {
    const settings = this.getSettings() as Record<string, string>;

    // Migrate: add capabilities that may be missing on already-paired devices
    if (!this.hasCapability('locked')) {
      await this.addCapability('locked').catch((err: Error) =>
        this.log('Could not add locked capability:', err.message),
      );
    }

    // Always register capability listeners, even before configuration
    this.registerCapabilityListener('onoff', async (value: boolean) => {
      if (!this.heater) throw new Error('Device not configured');
      await this.heater.setPower(value);
      this.scheduleReadback();
    });

    this.registerCapabilityListener('target_temperature', async (value: number) => {
      if (!this.heater) throw new Error('Device not configured');
      await this.heater.setTargetTemp(value);
      this.scheduleReadback();
    });

    this.registerCapabilityListener('ecoso_mode', async (value: string) => {
      if (!this.heater) throw new Error('Device not configured');
      await this.heater.setMode(value as 'Low' | 'High');
      this.scheduleReadback();
    });

    this.registerCapabilityListener('locked', async (value: boolean) => {
      if (!this.heater) throw new Error('Device not configured');
      await this.heater.setChildLock(value);
      this.scheduleReadback();
    });

    if (!settings.ip || !settings.local_key || !settings.tuya_id) {
      await this.setUnavailable(
        'Device not configured. Go to device settings and enter the IP Address, Device ID and Local Key.',
      );
      return;
    }

    this.useHeater(this.buildHeater(settings));
    this.startPolling();

    // Initial state sync — show error on card if it fails so it's visible without logs
    await this.syncState().catch(async (err: Error) => {
      this.log('Initial state sync failed (will retry on poll):', err.message);
      await this.setUnavailable(`Connection failed: ${err.message}`);
    });
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: Record<string, string | number | boolean | null | undefined>;
    newSettings: Record<string, string | number | boolean | null | undefined>;
    changedKeys: string[];
  }): Promise<void> {
    if (changedKeys.some((k) => ['ip', 'local_key', 'version', 'tuya_id'].includes(k))) {
      const s = newSettings as Record<string, string>;
      this.log(`Settings changed: ${changedKeys.join(', ')}. IP=${s.ip}, ID=${s.tuya_id}`);
      this.stopPolling();
      this.useHeater(this.buildHeater(s));

      if (s.ip && s.local_key && s.tuya_id) {
        try {
          await this.syncState();
          await this.setAvailable();
          this.startPolling();
          this.log('Device configured and online');
        } catch (err) {
          this.log('Failed to connect after settings change:', (err as Error).message);
          await this.setUnavailable(`Connection failed: ${(err as Error).message}`);
        }
      }
    }
  }

  async onDeleted() {
    this.stopPolling();
    this.clearReadback();
    this.disposeHeater();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private buildHeater(settings: Record<string, string>): EcosoHeater {
    return new EcosoHeater({
      name: this.getName(),
      id: settings['tuya_id'],
      ip: settings['ip'],
      key: settings['local_key'],
      version: settings['version'] || '3.4',
    });
  }

  /** Adopt a heater instance, wiring its pushed-state and availability events. */
  private useHeater(heater: EcosoHeater): void {
    this.disposeHeater();
    this.heater = heater;

    heater.on('state', (state: HeaterState) => {
      this.applyState(state).catch((err: Error) =>
        this.log('Failed to apply pushed state:', err.message),
      );
      this.setAvailable().catch(() => { /* ignore */ });
    });

    heater.on('connected', () => {
      this.setAvailable().catch(() => { /* ignore */ });
    });

    heater.on('unavailable', (retryInMs: number) => {
      this.log(`Heater not responding; retrying in ${Math.round(retryInMs / 1000)}s`);
      this.setUnavailable('Heater not responding').catch(() => { /* ignore */ });
    });
  }

  private disposeHeater(): void {
    if (!this.heater) return;
    this.heater.removeAllListeners();
    this.heater.close();
    this.heater = undefined;
  }

  private startPolling() {
    this.stopPolling();
    this.pollTimer = this.homey.setInterval(
      () => this.syncState().catch((err: Error) => this.log('Poll failed:', err.message)),
      POLL_INTERVAL_MS,
    );
  }

  private stopPolling() {
    if (this.pollTimer !== undefined) {
      this.homey.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Deferred re-read after a fire-and-forget set. Runs on the shared session,
   * so it does not open another connection.
   */
  private scheduleReadback() {
    this.clearReadback();
    this.readbackTimer = this.homey.setTimeout(
      () => {
        this.readbackTimer = undefined;
        this.syncState().catch(() => { /* silent — next poll will recover */ });
      },
      READBACK_DELAY_MS,
    );
  }

  private clearReadback() {
    if (this.readbackTimer !== undefined) {
      this.homey.clearTimeout(this.readbackTimer);
      this.readbackTimer = undefined;
    }
  }

  private async syncState() {
    if (!this.heater) return;
    const state = await this.heater.getState();
    await this.applyState(state);
    await this.setAvailable();
  }

  private async applyState(state: HeaterState): Promise<void> {
    const updates: Array<Promise<void>> = [];

    if (state.power !== null) {
      updates.push(this.setCapabilityValue('onoff', state.power));
    }
    if (state.targetTempC !== null) {
      updates.push(this.setCapabilityValue('target_temperature', state.targetTempC));
    }
    if (state.currentTempC !== null) {
      updates.push(this.setCapabilityValue('measure_temperature', state.currentTempC));
    }
    if (state.mode !== null) {
      updates.push(this.setCapabilityValue('ecoso_mode', state.mode));
    }
    if (state.childLock !== null) {
      updates.push(this.setCapabilityValue('locked', state.childLock));
    }

    await Promise.all(updates);
  }
}

module.exports = EcosoTorrDevice;
