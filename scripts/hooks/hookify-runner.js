#!/usr/bin/env node
/**
 * Event-aware Hookify runner. It always exits 0 and emits structured JSON.
 */

'use strict';

const { StringDecoder } = require('string_decoder');
const { isDryRun, isHookEnabled } = require('../lib/hook-flags');
const {
  LIMITS: LOADER_LIMITS,
  loadRules,
} = require('./hookify-loader');
const {
  evaluateRules,
  truncateUtf8,
} = require('./hookify-engine');

const LIMITS = Object.freeze({
  ...LOADER_LIMITS,
  maxInputBytes: 256 * 1024,
  maxOutputBytes: 8192,
  maxContextBytes: 7000,
  maxContextBytesWithBlock: 3000,
  maxBlockReasonBytes: 3800,
  regexTimeoutMs: 250,
});
const EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'UserPromptSubmit',
]);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasUnsafeControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      return true;
    }
  }
  return false;
}

function safeString(value, maxBytes) {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    !hasUnsafeControlCharacters(value)
  );
}

function expectedEventFromContext(context, payload) {
  if (EVENTS.has(context.expectedEvent)) return context.expectedEvent;
  if (context.hookId === 'pre:hookify') return 'PreToolUse';
  if (context.hookId === 'post:hookify') return 'PostToolUse';
  if (context.hookId === 'stop:hookify') return 'Stop';
  if (context.hookId === 'prompt:hookify') return 'UserPromptSubmit';
  return EVENTS.has(payload?.hook_event_name) ? payload.hook_event_name : null;
}

function validateInput(payload, expectedEvent) {
  if (!plainObject(payload)) return 'hook input must be a JSON object';
  if (!expectedEvent || payload.hook_event_name !== expectedEvent) {
    return 'hook event did not match the registered runtime event';
  }

  if (expectedEvent === 'PreToolUse' || expectedEvent === 'PostToolUse') {
    if (!safeString(payload.tool_name, 128) || !plainObject(payload.tool_input)) {
      return 'tool hooks require bounded tool_name and tool_input fields';
    }
  } else if (expectedEvent === 'UserPromptSubmit') {
    if (!safeString(payload.prompt, LIMITS.maxInputBytes)) {
      return 'UserPromptSubmit requires a bounded prompt string';
    }
  } else if (expectedEvent === 'Stop') {
    if (
      payload.last_assistant_message !== undefined &&
      !safeString(payload.last_assistant_message, LIMITS.maxInputBytes)
    ) {
      return 'Stop last_assistant_message must be a bounded string';
    }
    if (
      payload.stop_hook_active !== undefined &&
      typeof payload.stop_hook_active !== 'boolean'
    ) {
      return 'Stop stop_hook_active must be true or false';
    }
  }
  return null;
}

function ruleEventForInput(eventName, payload) {
  if (eventName === 'UserPromptSubmit') return 'prompt';
  if (eventName === 'Stop') return 'stop';
  if (payload.tool_name === 'Bash') return 'bash';
  if (FILE_TOOLS.has(payload.tool_name)) return 'file';
  return null;
}

function textByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function truncateText(value, maxBytes) {
  const text = String(value || '');
  if (textByteLength(text) <= maxBytes) return text;
  const marker = '\n… [Hookify output truncated]';
  return `${truncateUtf8(text, Math.max(0, maxBytes - textByteLength(marker)))}${marker}`;
}

function joinBounded(items, maxBytes) {
  return truncateText(items.filter(Boolean).join('\n\n'), maxBytes);
}

function formatRule(rule) {
  return `**[${rule.name}]**\n${rule.message}`;
}

function formatDiagnostics(diagnostics) {
  return diagnostics.map(item => `**[Hookify diagnostic]**\n${item.message}`);
}

function contextOutput(eventName, text) {
  if (!text) return {};
  if (eventName === 'Stop') return { systemMessage: text };
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: text,
    },
  };
}

function immutableSetText(output, key, value) {
  if (key === 'additionalContext') {
    return {
      ...output,
      hookSpecificOutput: {
        ...output.hookSpecificOutput,
        additionalContext: value,
      },
    };
  }
  if (key === 'permissionDecisionReason') {
    return {
      ...output,
      hookSpecificOutput: {
        ...output.hookSpecificOutput,
        permissionDecisionReason: value,
      },
    };
  }
  return { ...output, [key]: value };
}

function boundOutput(output) {
  let bounded = output;
  const textKeys = [
    'additionalContext',
    'systemMessage',
    'reason',
    'permissionDecisionReason',
  ];

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const serialized = JSON.stringify(bounded);
    if (Buffer.byteLength(serialized, 'utf8') <= LIMITS.maxOutputBytes) {
      return serialized;
    }

    let largest = null;
    for (const key of textKeys) {
      const value = key === 'additionalContext' || key === 'permissionDecisionReason'
        ? bounded.hookSpecificOutput?.[key]
        : bounded[key];
      if (typeof value !== 'string') continue;
      const bytes = textByteLength(value);
      if (!largest || bytes > largest.bytes) largest = { key, value, bytes };
    }
    if (!largest || largest.bytes <= 96) break;
    bounded = immutableSetText(
      bounded,
      largest.key,
      truncateText(largest.value, Math.max(96, Math.floor(largest.bytes * 0.6)))
    );
  }

  if (bounded.hookSpecificOutput?.permissionDecision === 'deny') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'A Hookify rule blocked this tool call; details were truncated.',
      },
    });
  }
  if (bounded.decision === 'block') {
    return JSON.stringify({
      decision: 'block',
      reason: 'A Hookify rule blocked this event; details were truncated.',
    });
  }
  return JSON.stringify(contextOutput(
    bounded.hookSpecificOutput?.hookEventName || 'PreToolUse',
    'Hookify diagnostic: output exceeded its configured limit.'
  ));
}

function buildOutput(eventName, matches, diagnostics) {
  const blocking = matches.filter(rule => rule.action === 'block');
  const warnings = matches.filter(rule => rule.action === 'warn');
  const contextItems = [
    ...warnings.map(formatRule),
    ...formatDiagnostics(diagnostics),
  ];
  const contextLimit = blocking.length > 0
    ? LIMITS.maxContextBytesWithBlock
    : LIMITS.maxContextBytes;
  const additionalContext = joinBounded(contextItems, contextLimit);
  const blockReason = joinBounded(blocking.map(formatRule), LIMITS.maxBlockReasonBytes);

  if (blocking.length === 0) {
    return contextOutput(eventName, additionalContext);
  }

  if (eventName === 'PreToolUse') {
    const hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: blockReason,
      ...(additionalContext ? { additionalContext } : {}),
    };
    return { hookSpecificOutput };
  }

  const reason = eventName === 'PostToolUse'
    ? [
      'The PostToolUse action already completed; this decision cannot undo it.',
      'Correct the result before continuing.',
      blockReason,
    ].join('\n\n')
    : blockReason;
  const output = {
    decision: 'block',
    reason,
  };
  if (!additionalContext) return output;
  if (eventName === 'Stop') return { ...output, systemMessage: additionalContext };
  return {
    ...output,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
}

function failOpen(eventName, message) {
  const safeEvent = EVENTS.has(eventName) ? eventName : 'PreToolUse';
  return buildOutput(safeEvent, [], [{
    code: 'HOOKIFY_INPUT_INVALID',
    message: `Hookify diagnostic: ${message}. Rules were not enforced for this event.`,
  }]);
}

function run(rawInput, context = {}) {
  const raw = typeof rawInput === 'string' ? rawInput : '';
  const preliminaryEvent = EVENTS.has(context.expectedEvent)
    ? context.expectedEvent
    : expectedEventFromContext(context, null);

  try {
    if (
      context.truncated === true ||
      Buffer.byteLength(raw, 'utf8') > LIMITS.maxInputBytes
    ) {
      return {
        stdout: boundOutput(failOpen(preliminaryEvent, 'input exceeded the byte limit')),
        stderr: '',
        exitCode: 0,
      };
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return {
        stdout: boundOutput(failOpen(preliminaryEvent, 'hook input was not valid JSON')),
        stderr: '',
        exitCode: 0,
      };
    }

    const eventName = expectedEventFromContext(context, payload);
    const inputError = validateInput(payload, eventName);
    if (inputError) {
      return {
        stdout: boundOutput(failOpen(eventName || preliminaryEvent, inputError)),
        stderr: '',
        exitCode: 0,
      };
    }
    if (eventName === 'Stop' && payload.stop_hook_active === true) {
      return {
        stdout: '{}',
        stderr: '',
        exitCode: 0,
      };
    }

    const loaded = loadRules({
      projectRoot: context.projectRoot || process.cwd(),
      event: ruleEventForInput(eventName, payload),
    });
    const evaluated = evaluateRules(loaded.rules, payload, {
      timeoutMs: LIMITS.regexTimeoutMs,
      maxFieldBytes: LIMITS.maxInputBytes,
    });
    const output = buildOutput(eventName, evaluated.matches, [
      ...loaded.diagnostics,
      ...evaluated.diagnostics,
    ]);
    return {
      stdout: boundOutput(output),
      stderr: '',
      exitCode: 0,
    };
  } catch {
    return {
      stdout: boundOutput(failOpen(preliminaryEvent, 'internal runtime failure')),
      stderr: '',
      exitCode: 0,
    };
  }
}

function readStdinBounded() {
  return new Promise(resolve => {
    const decoder = new StringDecoder('utf8');
    let raw = '';
    let bytesRead = 0;
    let truncated = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (!truncated) raw += decoder.end();
      resolve({ raw, truncated });
    };

    process.stdin.on('data', chunk => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, LIMITS.maxInputBytes - bytesRead);
      const accepted = buffer.subarray(0, remaining);
      if (accepted.length > 0) {
        raw += decoder.write(accepted);
        bytesRead += accepted.length;
      }
      if (accepted.length < buffer.length) {
        truncated = true;
        process.stdin.destroy();
        finish();
      }
    });
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
  });
}

async function cli() {
  const expectedEvent = EVENTS.has(process.argv[2]) ? process.argv[2] : null;
  const hookId = typeof process.argv[3] === 'string' ? process.argv[3] : '';
  const profiles = typeof process.argv[4] === 'string'
    ? process.argv[4]
    : 'minimal,standard,strict';
  const input = await readStdinBounded();
  const passthrough = input.truncated ? '' : input.raw;
  if (hookId && !isHookEnabled(hookId, { profiles })) {
    process.exitCode = 0;
    process.stdout.write(passthrough);
    return;
  }
  if (isDryRun()) {
    process.exitCode = 0;
    process.stderr.write(
      `[DryRun] Hook "${hookId || 'hookify'}" would evaluate ${expectedEvent || 'an unknown event'} rules\n`
    );
    process.stdout.write(passthrough);
    return;
  }
  const result = run(input.raw, {
    expectedEvent,
    truncated: input.truncated,
    projectRoot: process.cwd(),
  });
  process.exitCode = 0;
  process.stdout.write(result.stdout);
}

if (require.main === module) {
  cli().catch(() => {
    process.exitCode = 0;
    process.stdout.write(boundOutput(failOpen(process.argv[2], 'internal runtime failure')));
  });
}

module.exports = {
  LIMITS,
  boundOutput,
  buildOutput,
  cli,
  run,
  validateInput,
};
