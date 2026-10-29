'use strict';

/**
 * One-time setup: create data/config.json, generate the local HTTPS
 * certificate and the PWA icons. Run via `node scripts/setup.js` or install.cmd.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadConfig } = require('../server/config');
const { ensureCertificate } = require('../server/tls');
const { getLanAddresses } = require('../server/util');
const { generateIcons } = require('./make-icons');

function main() {
  const root = path.resolve(__dirname, '..');

  console.log('[setup] Generating app icons...');
  generateIcons();

  console.log('[setup] Creating config and TLS certificate...');
  const { config, dataDir, configPath } = loadConfig({});
  const tls = ensureCertificate(dataDir);

  const lan = getLanAddresses();
  const token = config.security.token;
  const pairingBase = lan.length ? `https://${lan[0].address}:${config.server.httpsPort}` : `https://localhost:${config.server.httpsPort}`;

  console.log('');
  console.log('  Setup complete.');
  console.log('');
  console.log(`  Config file:       ${configPath}`);
  console.log(`  TLS certificate:   ${tls.certPath}`);
  console.log(`  Access token:      ${token}`);
  console.log(`  Pairing link:      ${pairingBase}/?token=${encodeURIComponent(token)}`);
  console.log('');
  console.log('  Start the bridge with:  start.cmd   (or: npm start)');
  console.log('');
  console.log(`  Machine:  ${os.hostname()}   Node ${process.version}`);
}

main();
