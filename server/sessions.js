'use strict';

const { randId } = require('./util');

/**
 * In-memory conversation sessions. A session groups one request and its
 * follow-ups ("open it" after a search) and remembers the last search results
 * so follow-up commands can act on them.
 */
class SessionStore {
  constructor({ max = 200 } = {}) {
    this.max = max;
    this.sessions = new Map();
  }

  create({ agentId = null, source = 'unknown', title = '' } = {}) {
    const now = new Date().toISOString();
    const session = {
      id: randId('s_', 10),
      agentId,
      source,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      context: {}
    };
    this.sessions.set(session.id, session);
    this.prune();
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  list({ limit = 30 } = {}) {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        agentId: s.agentId,
        source: s.source,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length
      }));
  }

  addMessage(id, message) {
    const session = this.get(id);
    if (!session) return null;
    session.messages.push(message);
    if (session.messages.length > 80) session.messages.splice(0, session.messages.length - 80);
    session.updatedAt = new Date().toISOString();
    return session;
  }

  update(id, patch) {
    const session = this.get(id);
    if (!session) return null;
    Object.assign(session, patch);
    session.updatedAt = new Date().toISOString();
    return session;
  }

  prune() {
    if (this.sessions.size <= this.max) return;
    const oldest = [...this.sessions.values()]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, this.sessions.size - this.max);
    for (const session of oldest) this.sessions.delete(session.id);
  }

  get size() {
    return this.sessions.size;
  }
}

module.exports = { SessionStore };
