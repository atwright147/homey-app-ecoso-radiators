import { App } from 'homey';

class EcosoApp extends App {
  async onInit() {
    this.log('ECOSO Radiators app initialized');

    this.homey.flow
      .getActionCard('set_mode')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .registerRunListener(async (args: { device: any; mode: string }) => {
        await args.device.triggerCapabilityListener('ecoso_mode', args.mode);
      });
  }
}

module.exports = EcosoApp;
