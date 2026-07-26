#!/usr/bin/env node
/**
 * Hookify field extraction and bounded rule evaluation.
 */

'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'hookify-regex-worker.js');
const WORKER_RESULT_BYTES = 64 * 1024;
const HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * 2;
const DEFAULT_TIMEOUT_MS = 250;
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_EDIT_ITEMS = 256;

function truncateUtf8(value, maxBytes = MAX_FIELD_BYTES) {
  const input = String(value);
  const encoded = Buffer.from(input, 'utf8');
  if (encoded.length <= maxBytes) return input;

  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}

function stringField(value) {
  return typeof value === 'string' ? truncateUtf8(value) : null;
}

function editValues(toolInput, field) {
  if (!Array.isArray(toolInput.edits)) return null;
  const values = [];
  for (const edit of toolInput.edits.slice(0, MAX_EDIT_ITEMS)) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) continue;
    const value = stringField(edit[field]);
    if (value !== null) values.push(value);
  }
  return truncateUtf8(values.join('\n'));
}

function fileContent(toolName, toolInput) {
  if (toolName === 'MultiEdit') {
    return editValues(toolInput, 'new_string') || '';
  }
  if (toolName === 'NotebookEdit') {
    return stringField(toolInput.new_source) ?? '';
  }
  return (
    stringField(toolInput.content) ??
    stringField(toolInput.new_text) ??
    stringField(toolInput.new_string) ??
    ''
  );
}

function extractConditionValue(field, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput = input.tool_input &&
    typeof input.tool_input === 'object' &&
    !Array.isArray(input.tool_input)
    ? input.tool_input
    : {};

  switch (field) {
    case 'command':
      return toolName === 'Bash' ? stringField(toolInput.command) : null;
    case 'file_path':
      return ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)
        ? stringField(toolInput.file_path) ?? stringField(toolInput.notebook_path)
        : null;
    case 'new_text':
      if (toolName === 'MultiEdit') return editValues(toolInput, 'new_string');
      if (!['Edit', 'Write', 'NotebookEdit'].includes(toolName)) return null;
      return (
        stringField(toolInput.new_text) ??
        stringField(toolInput.new_string) ??
        stringField(toolInput.new_source) ??
        stringField(toolInput.content)
      );
    case 'old_text':
      if (toolName === 'MultiEdit') return editValues(toolInput, 'old_string');
      if (!['Edit', 'Write', 'NotebookEdit'].includes(toolName)) return null;
      return stringField(toolInput.old_text) ?? stringField(toolInput.old_string);
    case 'user_prompt':
      return input.hook_event_name === 'UserPromptSubmit'
        ? stringField(input.prompt)
        : null;
    case 'content':
      if (input.hook_event_name === 'Stop') {
        return stringField(input.last_assistant_message) ?? '';
      }
      if (input.hook_event_name === 'UserPromptSubmit') {
        return stringField(input.prompt) ?? '';
      }
      if (toolName === 'Bash') return stringField(toolInput.command) ?? '';
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
        return fileContent(toolName, toolInput);
      }
      return null;
    default:
      return null;
  }
}

function matchesTool(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  return matcher.split('|').includes(toolName);
}

function safeWorkerResult() {
  return {
    matchedIndexes: [],
    diagnostics: [{
      code: 'HOOKIFY_REGEX_WORKER_FAILED',
      message: 'Hookify skipped rule evaluation: isolated worker failed.',
    }],
  };
}

function runWorker(tasks, values, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sharedBuffer = new SharedArrayBuffer(WORKER_RESULT_BYTES);
  const header = new Int32Array(sharedBuffer, 0, 2);
  let worker;
  try {
    worker = new Worker(WORKER_PATH, {
      workerData: { tasks, values, sharedBuffer },
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        codeRangeSizeMb: 8,
        stackSizeMb: 2,
      },
    });
    worker.on('error', () => {});
    worker.unref();
  } catch {
    return safeWorkerResult();
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    worker.terminate().catch(() => {});
    return {
      matchedIndexes: [],
      diagnostics: [{
        code: 'HOOKIFY_REGEX_TIMEOUT',
        message: 'Hookify skipped rule evaluation: regular-expression deadline exceeded.',
      }],
    };
  }
  const waitResult = Atomics.wait(header, 0, 0, remainingMs);
  if (waitResult === 'timed-out') {
    worker.terminate().catch(() => {});
    return {
      matchedIndexes: [],
      diagnostics: [{
        code: 'HOOKIFY_REGEX_TIMEOUT',
        message: 'Hookify skipped rule evaluation: regular-expression deadline exceeded.',
      }],
    };
  }

  const state = Atomics.load(header, 0);
  const outputLength = Atomics.load(header, 1);
  worker.terminate().catch(() => {});
  if (
    state < 1 ||
    outputLength < 1 ||
    outputLength > WORKER_RESULT_BYTES - HEADER_BYTES
  ) {
    return safeWorkerResult();
  }

  try {
    const bytes = new Uint8Array(sharedBuffer, HEADER_BYTES, outputLength);
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (
      !Array.isArray(parsed.matchedIndexes) ||
      !Array.isArray(parsed.diagnostics)
    ) {
      return safeWorkerResult();
    }
    return parsed;
  } catch {
    return safeWorkerResult();
  }
}

function evaluateRules(rules, input, options = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { matches: [], diagnostics: [] };
  }

  const toolName = typeof input?.tool_name === 'string' ? input.tool_name : '';
  const tasks = [];
  const fields = new Set();
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!matchesTool(rule.toolMatcher, toolName)) continue;
    tasks.push({
      index,
      source: rule.source,
      conditions: rule.conditions.map(condition => ({
        field: condition.field,
        operator: condition.operator,
        pattern: condition.pattern,
      })),
    });
    for (const condition of rule.conditions) fields.add(condition.field);
  }
  if (tasks.length === 0) return { matches: [], diagnostics: [] };
  const values = {};
  for (const field of fields) {
    values[field] = extractConditionValue(field, input);
  }

  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(Math.floor(requestedTimeout), 1000)
    : DEFAULT_TIMEOUT_MS;
  const result = runWorker(tasks, values, timeoutMs);
  const matched = new Set(
    result.matchedIndexes.filter(
      index => Number.isInteger(index) && index >= 0 && index < rules.length
    )
  );

  return {
    matches: rules.filter((_rule, index) => matched.has(index)),
    diagnostics: result.diagnostics,
  };
}

module.exports = {
  evaluateRules,
  extractConditionValue,
  matchesTool,
  truncateUtf8,
};
