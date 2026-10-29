'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  timingSafeEqualStr,
  tokenFromRequest,
  createRateLimiter,
  isAuthorized,
  clientIp
} = require('../server/security');

test('timingSafeEqualStr compares safely', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStr('', ''), false);
  assert.equal(timingSafeEqualStr(null, 'abc'), false);
  assert.equal(timingSafeEqualStr('abc', undefined), false);
});

test('tokenFromRequest reads header, bearer and query', () => {
  assert.equal(tokenFromRequest({ headers: { 'x-bridge-token': 'abc' } }, new URL('http://x/')), 'abc');
  assert.equal(tokenFromRequest({ headers: { authorization: 'Bearer xyz' } }, new URL('http://x/')), 'xyz');
  assert.equal(tokenFromRequest({ headers: {} }, new URL('http://x/?token=qwe')), 'qwe');
  assert.equal(tokenFromRequest({ headers: {} }, new URL('http://x/')), null);
});

test('isAuthorized requires an exact token', () => {
  const config = { security: { token: 'SECRET' } };
  assert.equal(isAuthorized(config, { method: 'GET', headers: { 'x-bridge-token': 'SECRET' } }, new URL('http://x/')), true);
  assert.equal(isAuthorized(config, { method: 'GET', headers: { 'x-bridge-token': 'secret' } }, new URL('http://x/')), false);
  assert.equal(isAuthorized(config, { method: 'GET', headers: {} }, new URL('http://x/')), false);
});

test('query tokens are accepted for GET but rejected for POST', () => {
  const config = { security: { token: 'SECRET' } };
  const url = new URL('http://x/?token=SECRET');
  assert.equal(isAuthorized(config, { method: 'GET', headers: {} }, url), true);
  assert.equal(isAuthorized(config, { method: 'HEAD', headers: {} }, url), true);
  assert.equal(isAuthorized(config, { method: 'POST', headers: {} }, url), false);
  assert.equal(isAuthorized(config, { method: 'POST', headers: { 'x-bridge-token': 'SECRET' } }, url), true);
});

test('clientIp ignores spoofed X-Forwarded-For from non-loopback peers', () => {
  const spoofed = { socket: { remoteAddress: '192.168.1.50' }, headers: { 'x-forwarded-for': '1.1.1.1' } };
  assert.equal(clientIp(spoofed), '192.168.1.50');

  const proxied = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' } };
  assert.equal(clientIp(proxied), '8.8.8.8');

  const direct = { socket: { remoteAddress: '192.168.1.51' }, headers: {} };
  assert.equal(clientIp(direct), '192.168.1.51');
});

test('rate limiter bans after repeated failures and resets on success', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, banMs: 500 });

  assert.equal(limiter.check('1.2.3.4').ok, true);
  limiter.fail('1.2.3.4');
  assert.equal(limiter.check('1.2.3.4').ok, true);
  limiter.fail('1.2.3.4');
  const banned = limiter.check('1.2.3.4');
  assert.equal(banned.ok, false);
  assert.ok(banned.retryAfterMs > 0);

  limiter.reset();
  assert.equal(limiter.check('1.2.3.4').ok, true);

  limiter.fail('5.6.7.8');
  limiter.success('5.6.7.8');
  for (let i = 0; i < 20; i += 1) limiter.fail('5.6.7.8');
  assert.equal(limiter.check('5.6.7.8').ok, false);
});
