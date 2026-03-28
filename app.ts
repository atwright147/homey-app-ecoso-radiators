import { App } from 'homey';

class EcosoApp extends App {
  async onInit() {
    this.log('ECOSO Radiators app initialized');
  }
}

module.exports = EcosoApp;
