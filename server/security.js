'use strict';

const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function tokenFromRequest(req, url) {
  const header = req.headers && req.headers['x-bridge-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();

  const auth = req.headers && req.headers.authorization;
  if (typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  if (url && typeof url.searchParams?.get === 'function') {
    const query = url.searchParams.get('token');
    if (query) return query.trim();
  }
  return null;
}

/**
 * Authorize a request.
 *
 * Header or Bearer tokens are accepted for every method. The `?token=` query
 * parameter is only accepted for GET/HEAD (EventSource and <img> cannot set
 * custom headers). POSTs must prove the token in a header, which also keeps
 * secrets out of URLs for state-changing requests.
 */
function isAuthorized(config, req, url) {
  const expected = config?.security?.token;
  if (!expected) return false;
  const method = String((req && req.method) || 'GET').toUpperCase();

  let supplied = null;
  const header = req.headers && req.headers['x-bridge-token'];
  if (typeof header === 'string' && header.trim()) supplied = header.trim();

  if (!supplied) {
    const auth = req.headers && req.headers.authorization;
    if (typeof auth === 'string') {
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (match) supplied = match[1].trim();
    }
  }

  if (!supplied && (method === 'GET' || method === 'HEAD') && url && typeof url.searchParams?.get === 'function') {
    const query = url.searchParams.get('token');
    if (query) supplied = query.trim();
  }

  if (!supplied) return false;
  return timingSafeEqualStr(supplied, expected);
}

/**
 * Simple per-IP failure limiter. Successful auth clears the counter for the
 * IP so normal use never trips it.
 */
function createRateLimiter({ windowMs = 300000, max = 12, banMs = 600000 } = {}) {
  const attempts = new Map();

  function entry(ip) {
    let e = attempts.get(ip);
    if (!e) {
      e = { count: 0, firstAt: Date.now(), bannedUntil: 0 };
      attempts.set(ip, e);
    }
    return e;
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of attempts) {
      if (now - e.firstAt > windowMs && now >= (e.bannedUntil || 0)) attempts.delete(ip);
    }
  }, Math.max(60000, windowMs));
  sweeper.unref?.();

  return {
    check(ip) {
      const now = Date.now();
      const e = attempts.get(ip);
      if (!e) return { ok: true };
      if (e.bannedUntil && now < e.bannedUntil) return { ok: false, retryAfterMs: e.bannedUntil - now };
      if (now - e.firstAt > windowMs) {
        attempts.delete(ip);
        return { ok: true };
      }
      if (e.count >= max) {
        e.bannedUntil = now + banMs;
        return { ok: false, retryAfterMs: banMs };
      }
      return { ok: true };
    },
    fail(ip) {
      const e = entry(ip);
      const now = Date.now();
      if (now - e.firstAt > windowMs) {
        e.count = 0;
        e.firstAt = now;
        e.bannedUntil = 0;
      }
      e.count += 1;
    },
    success(ip) {
      attempts.delete(ip);
    },
    reset() {
      attempts.clear();
    }
  };
}

/**
 * Best-effort client IP for rate limiting.
 *
 * `X-Forwarded-For` is only trusted when the direct peer is loopback (i.e. a
 * local reverse proxy / tunnel agent). Otherwise a remote client could rotate
 * the header to dodge the auth-failure ban.
 */
function clientIp(req) {
  const socketIp = (req.socket && req.socket.remoteAddress) || 'unknown';
  const loopback = socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '::ffff:127.0.0.1';
  if (loopback) {
    const forwarded = req.headers && req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return socketIp;
}

module.exports = { timingSafeEqualStr, tokenFromRequest, createRateLimiter, isAuthorized, clientIp };
