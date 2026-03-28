import { Driver } from 'homey';

class EcosoTorrDriver extends Driver {
  async onInit() {
    this.log('ECOSO Torr driver initialized');
  }

  async onPairListDevices() {
    return [
      {
        name: 'ECOSO Torr',
        data: { id: `ecoso-torr-${Date.now()}` },
        settings: { tuya_id: '', ip: '', local_key: '', version: '3.4' },
      },
    ];
  }
}

module.exports = EcosoTorrDriver;
