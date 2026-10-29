'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { ensureCertificate, altNamesForThisMachine, certificateCovers } = require('../server/tls');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heyai-tls-'));
}

test('ensureCertificate creates a CA-capable cert covering this machine and reuses it', () => {
  const dataDir = tmp();
  const first = ensureCertificate(dataDir);
  assert.equal(first.regenerated, true);
  assert.ok(fs.existsSync(first.certPath));
  assert.ok(fs.existsSync(first.keyPath));

  const cert = new crypto.X509Certificate(fs.readFileSync(first.certPath));
  assert.equal(cert.ca, true, 'cert must be installable as an Android CA');
  assert.ok(certificateCovers(cert, altNamesForThisMachine()), 'cert must cover localhost/LAN/hostname');

  const second = ensureCertificate(dataDir);
  assert.equal(second.regenerated, false);
});

test('certificateCovers rejects certificates that miss a required name', () => {
  const dataDir = tmp();
  const { cert } = ensureCertificate(dataDir);
  const parsed = new crypto.X509Certificate(cert);
  assert.equal(certificateCovers(parsed, [{ type: 7, ip: '10.255.255.1' }]), false);
  assert.equal(certificateCovers(parsed, [{ type: 2, value: 'not-my-hostname.invalid' }]), false);
});
