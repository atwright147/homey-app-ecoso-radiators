/**
 * scanner.ts — Pure Node.js UDP Tuya LAN discovery
 *
 * Listens on ports 6666 and 6667 for Tuya device broadcasts.
 * Packets are AES-128-ECB encrypted using the standard Tuya discovery key
 * derived from MD5("yGAdlopoPVldABfn").
 *
 * Packet format:
 *   [0:4]   prefix 0x000055AA
 *   [4:8]   sequence number (uint32 BE)
 *   [8:12]  command (uint32 BE)
 *   [12:16] data length (uint32 BE) — includes payload + 4-byte CRC
 *   [16 : 16+len-4]  encrypted payload
 *   [16+len-4 : 16+len]  CRC32
 */

import * as dgram from 'dgram';
import * as crypto from 'crypto';

const TUYA_PREFIX = Buffer.from('000055aa', 'hex');

// AES-128-ECB key = MD5("yGAdlopoPVldABfn")
const DISCOVERY_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

export interface DiscoveredDevice {
  ip: string;
  id: string;
  version: string;
  productKey?: string;
}

/**
 * Attempt to extract the JSON payload from a Tuya UDP broadcast packet.
 * Tries plain JSON first, then AES-128-ECB with PKCS7 padding, then without.
 */
function parseTuyaPacket(msg: Buffer, srcIp: string): DiscoveredDevice | null {
  // Validate prefix
  if (msg.length < 20) return null;
  if (!msg.subarray(0, 4).equals(TUYA_PREFIX)) return null;

  const dataLen = msg.readUInt32BE(12);
  if (dataLen < 4 || msg.length < 16 + dataLen) return null;

  // Payload slice (strip 4-byte CRC at the end of the data segment)
  const payload = msg.subarray(16, 16 + dataLen - 4);

  let parsed: Record<string, unknown> | null = null;

  // 1. Plain JSON (unencrypted, v1/v2 devices)
  try {
    parsed = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
  } catch {
    // not plain JSON
  }

  // 2. AES-128-ECB with PKCS7 auto-unpadding
  if (!parsed && payload.length > 0 && payload.length % 16 === 0) {
    try {
      const dec = crypto.createDecipheriv('aes-128-ecb', DISCOVERY_KEY, null);
      const out = Buffer.concat([dec.update(payload), dec.final()]);
      parsed = JSON.parse(out.toString('utf8')) as Record<string, unknown>;
    } catch {
      // wrong encoding or padding
    }
  }

  // 3. AES-128-ECB with manual null-byte stripping (zero-padded)
  if (!parsed && payload.length > 0 && payload.length % 16 === 0) {
    try {
      const dec = crypto.createDecipheriv('aes-128-ecb', DISCOVERY_KEY, null);
      dec.setAutoPadding(false);
      const out = Buffer.concat([dec.update(payload), dec.final()]);
      const text = out.toString('utf8').replace(/\0+$/, '');
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not decryptable
    }
  }

  if (!parsed) return null;

  const id = typeof parsed['gwId'] === 'string' ? parsed['gwId'] : null;
  if (!id) return null;

  return {
    ip: (typeof parsed['ip'] === 'string' ? parsed['ip'] : null) ?? srcIp,
    id,
    version: typeof parsed['version'] === 'string' ? parsed['version'] : '3.4',
    productKey: typeof parsed['productKey'] === 'string' ? parsed['productKey'] : undefined,
  };
}

/**
 * Scan the local network for Tuya devices by listening on UDP ports 6666 and 6667.
 * Returns all unique devices discovered within the given timeout.
 *
 * @param timeoutMs  How long to listen (default 8 seconds)
 */
export function scanForDevices(timeoutMs = 8000): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredDevice>();
    const sockets: dgram.Socket[] = [];
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      for (const sock of sockets) {
        try { sock.close(); } catch { /* ignore */ }
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    const handleMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      const device = parseTuyaPacket(msg, rinfo.address);
      if (device && !found.has(device.id)) {
        found.set(device.id, device);
      }
    };

    for (const port of [6666, 6667]) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', handleMessage);
      sock.on('error', () => { /* ignore binding/receive errors */ });
      sock.bind(port, () => {
        try { sock.setBroadcast(true); } catch { /* ignore */ }
      });
      sockets.push(sock);
    }

    // Safety cleanup if something goes wrong with the timer
    void timer;
  });
}
