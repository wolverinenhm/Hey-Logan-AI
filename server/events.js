'use strict';

/**
 * Server-Sent Events hub. One connection per UI (phone or PC browser tab).
 * Every event is a JSON object with a `type`; the UI subscribes to all of
 * them and decides what to display / speak.
 */
class EventHub {
  constructor({ heartbeatMs = 25000 } = {}) {
    this.clients = new Map();
    this.seq = 0;
    this.timer = setInterval(() => this.heartbeat(), heartbeatMs);
    this.timer.unref?.();
  }

  subscribe(clientId, req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const hello = { type: 'hello', clientId, ts: Date.now() };
    res.write(`data: ${JSON.stringify(hello)}\n\n`);

    const client = { id: clientId, res };
    this.clients.set(clientId, client);

    const cleanup = () => {
      if (this.clients.get(clientId) === client) this.clients.delete(clientId);
      try { res.end(); } catch { /* already closed */ }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    return client;
  }

  publish(event) {
    const payload = { id: ++this.seq, ts: Date.now(), ...event };
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const [id, client] of this.clients) {
      try {
        client.res.write(frame);
      } catch {
        this.clients.delete(id);
      }
    }
    return payload;
  }

  heartbeat() {
    for (const [id, client] of this.clients) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        this.clients.delete(id);
      }
    }
  }

  close() {
    clearInterval(this.timer);
    for (const client of this.clients.values()) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  get size() {
    return this.clients.size;
  }
}

module.exports = { EventHub };
