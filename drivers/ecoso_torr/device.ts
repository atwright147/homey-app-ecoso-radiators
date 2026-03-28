import { Device } from 'homey';
import { EcosoHeater } from '../../lib/heater';
import type { HeaterState } from '../../lib/heater';

const POLL_INTERVAL_MS = 30_000;
const READBACK_DELAY_MS = 1_200;

class EcosoTorrDevice extends Device {
  private heater!: EcosoHeater;
  private pollTimer?: NodeJS.Timeout;

  async onInit() {
    const settings = this.getSettings() as Record<string, string>;

    if (!settings.ip || !settings.local_key || !settings.tuya_id) {
      await this.setUnavailable(
        'Device not configured. Go to device settings and enter the IP Address, Device ID and Local Key.',
      );
      return;
    }

    this.heater = this.buildHeater(settings);

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await this.heater.setPower(value);
      this.scheduleReadback();
    });

    this.registerCapabilityListener('target_temperature', async (value: number) => {
      await this.heater.setTargetTemp(value);
      this.scheduleReadback();
    });

    this.registerCapabilityListener('ecoso_mode', async (value: string) => {
      await this.heater.setMode(value as 'Low' | 'High');
      this.scheduleReadback();
    });

    this.startPolling();

    // Initial state sync
    await this.syncState().catch((err: Error) =>
      this.log('Initial state sync failed (will retry on poll):', err.message),
    );
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
      this.heater = this.buildHeater(s);

      if (s.ip && s.local_key && s.tuya_id) {
        await this.setAvailable();
        await this.syncState();
      }
    }
  }

  async onDeleted() {
    this.stopPolling();
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

  /** Deferred re-read after a fire-and-forget set command clears the wire. */
  private scheduleReadback() {
    this.homey.setTimeout(
      () => this.syncState().catch(() => { /* silent — next poll will recover */ }),
      READBACK_DELAY_MS,
    );
  }

  private async syncState() {
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

    await Promise.all(updates);
  }
}

module.exports = EcosoTorrDevice;
