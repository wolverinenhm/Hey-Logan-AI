'use strict';

const { getAgentDefs, getAgentDef } = require('./defs');
const { resolveCliCommand } = require('./cli');
const { providerChain } = require('./llm');

/**
 * Agent list for the UI: presentation data + whether each agent is actually
 * installed/available on this machine right now.
 */
function describeAgents(config) {
  return getAgentDefs().map((def) => {
    const cfg = (config.agents && config.agents[def.id]) || {};
    const base = {
      id: def.id,
      name: def.name,
      kind: def.kind,
      icon: def.icon,
      color: def.color,
      description: def.description,
      wake: def.wake,
      weak: def.weak,
      ack: def.ack,
      voice: def.voice,
      install: def.cli ? def.cli.install : null,
      docsUrl: def.cli ? def.cli.docsUrl : null
    };

    if (def.kind === 'computer') {
      return { ...base, enabled: cfg.enabled !== false, executable: 'built-in', expectedCommand: 'built-in' };
    }

    if (def.kind === 'llm') {
      const chain = providerChain(config);
      return {
        ...base,
        enabled: cfg.enabled !== false && chain.length > 0,
        executable: chain.length ? `built-in · ${chain.map((p) => p.id).join(' → ')}` : null,
        expectedCommand: 'built-in',
        providers: chain.map((p) => p.id)
      };
    }

    const { resolved, command } = resolveCliCommand(def.id, def, config);
    const enabled = cfg.enabled !== false && Boolean(resolved);

    return {
      ...base,
      enabled,
      executable: resolved || null,
      expectedCommand: command
    };
  });
}

function getAgentRuntime(agentId, config) {
  const def = getAgentDef(agentId);
  if (!def) return null;
  if (def.kind === 'computer') return { def, kind: 'computer', resolved: 'built-in' };
  if (def.kind === 'llm') return { def, kind: 'llm', resolved: 'built-in' };
  const { resolved, command } = resolveCliCommand(agentId, def, config);
  return { def, kind: 'cli', resolved, command };
}

module.exports = { describeAgents, getAgentRuntime };
