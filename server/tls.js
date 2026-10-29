'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const selfsigned = require('selfsigned');

const { getLanAddresses } = require('./util');

/** Alt names the certificate must cover for this machine right now. */
function altNamesForThisMachine() {
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' }
  ];
  for (const lan of getLanAddresses()) altNames.push({ type: 7, ip: lan.address });
  const hostname = os.hostname();
  if (hostname) altNames.push({ type: 2, value: hostname });
  return altNames;
}

/** True when an existing certificate is still valid and covers every name. */
function certificateCovers(cert, altNames) {
  const san = String(cert.subjectAltName || '');
  for (const entry of altNames) {
    const label = entry.type === 7 ? `IP Address:${entry.ip}` : `DNS:${entry.value}`;
    if (!san.includes(label)) return false;
  }
  return true;
}

/**
 * Get (or generate) the local self-signed certificate used for HTTPS.
 * Phones require a secure context (HTTPS) before they allow microphone access,
 * so HTTPS is the default path for the Android PWA.
 *
 * The certificate covers localhost, every LAN IP and the machine hostname.
 * It is regenerated automatically when missing, invalid, about to expire, or
 * when the machine's LAN IP changed (so a new IP is always covered).
 */
function ensureCertificate(dataDir) {
  const certDir = path.join(dataDir, 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  const altNames = altNamesForThisMachine();

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
      const daysLeft = (new Date(cert.validTo).getTime() - Date.now()) / 86400000;
      // `ca` must be true so the certificate can also be installed as a
      // trusted CA on Android (see docs/ANDROID-SETUP.md).
      if (daysLeft > 7 && cert.ca === true && certificateCovers(cert, altNames)) {
        return {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath),
          keyPath,
          certPath,
          regenerated: false
        };
      }
    } catch {
      /* fall through and regenerate */
    }
  }

  const pems = selfsigned.generate(
    [
      { name: 'commonName', value: 'Hey AI Bridge' },
      { name: 'organizationName', value: 'Hey AI Bridge (local)' }
    ],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
        { name: 'subjectAltName', altNames }
      ]
    }
  );

  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert);

  return { key: pems.private, cert: pems.cert, keyPath, certPath, regenerated: true };
}

module.exports = { ensureCertificate, altNamesForThisMachine, certificateCovers };
