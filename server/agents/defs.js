'use strict';

/**
 * Agent catalog. Each entry defines:
 *  - wake phrases (strong: "hey claude code"; weak: bare name at start of utterance)
 *  - UI presentation (name, icon, colour)
 *  - how to invoke the CLI (command + argv template, {prompt} placeholder)
 *
 * Users can override every `cli` field from data/config.json -> agents.<id>.
 */
const AGENTS = [
  {
    id: 'computer',
    name: 'Computer',
    kind: 'computer',
    icon: '🖥',
    color: '#22d3ee',
    description: 'Search files, open apps, lock the screen, take screenshots',
    wake: ['hey computer', 'hey pc', 'hey laptop', 'hey machine', 'hey this computer'],
    weak: ['computer', 'pc'],
    ack: 'Computer here.',
    voice: { rate: 1.02, pitch: 1.0 }
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'cli',
    icon: '✳',
    color: '#d97757',
    description: 'Anthropic Claude Code CLI',
    wake: ['hey claude code', 'hey claude', 'hey claud', 'hey cloud code'],
    weak: ['claude code', 'claude'],
    ack: 'Claude Code here.',
    voice: { rate: 1.0, pitch: 0.95 },
    cli: {
      command: 'claude',
      args: ['-p', '{prompt}'],
      timeoutMs: 300000,
      docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
      install: 'npm install -g @anthropic-ai/claude-code'
    }
  },
  {
    id: 'codex',
    name: 'Codex',
    kind: 'cli',
    icon: '⌬',
    color: '#10b981',
    description: 'OpenAI Codex CLI',
    wake: ['hey codex', 'hey code x', 'hey codecs'],
    weak: ['codex'],
    ack: 'Codex here.',
    voice: { rate: 1.06, pitch: 1.02 },
    cli: {
      command: 'codex',
      args: ['exec', '{prompt}'],
      timeoutMs: 300000,
      docsUrl: 'https://github.com/openai/codex',
      install: 'npm install -g @openai/codex'
    }
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Harness',
    kind: 'cli',
    icon: '🐳',
    color: '#4f7cff',
    description: 'DeepSeek Harness via `dsh headless`',
    wake: ['hey deepseek', 'hey deep seek', 'hey dsh', 'hey deepseek harness'],
    weak: ['deepseek', 'deep seek', 'dsh'],
    ack: 'DeepSeek here.',
    voice: { rate: 1.0, pitch: 1.0 },
    cli: {
      command: 'dsh',
      args: ['headless', '{prompt}'],
      timeoutMs: 900000,
      docsUrl: 'https://github.com/deepseek-ai',
      install: 'Installed together with DeepSeek Harness (dsh CLI)'
    }
  },
  {
    id: 'workbuddy',
    name: 'Workbuddy',
    kind: 'cli',
    icon: '💼',
    color: '#f59e0b',
    description: 'Workbuddy desktop agent (configurable CLI)',
    wake: ['hey workbuddy', 'hey work buddy', 'hey work body'],
    weak: ['workbuddy', 'work buddy'],
    ack: 'Workbuddy here.',
    voice: { rate: 1.03, pitch: 1.05 },
    cli: {
      command: 'workbuddy',
      args: ['--prompt', '{prompt}'],
      timeoutMs: 300000,
      docsUrl: '',
      install: 'Set agents.workbuddy.command in data/config.json to your Workbuddy executable'
    }
  },
  {
    id: 'gemini',
    name: 'Gemini',
    kind: 'cli',
    icon: '✨',
    color: '#8b5cf6',
    description: 'Google Gemini CLI',
    wake: ['hey gemini', 'hey gem mini', 'hey geminy'],
    weak: ['gemini'],
    ack: 'Gemini here.',
    voice: { rate: 1.05, pitch: 1.0 },
    cli: {
      command: 'gemini',
      args: ['-p', '{prompt}'],
      timeoutMs: 300000,
      docsUrl: 'https://github.com/google-gemini/gemini-cli',
      install: 'npm install -g @google/gemini-cli'
    }
  }
];

const GENERIC_WAKE = ['hey ai', 'hey assistant', 'hey agents', 'hey anybody', 'hey bridge'];

function getAgentDef(id) {
  return AGENTS.find((agent) => agent.id === id) || null;
}

function getAgentDefs() {
  return AGENTS;
}

module.exports = { AGENTS, GENERIC_WAKE, getAgentDef, getAgentDefs };
