#!/usr/bin/env node
/**
 * Isolated condition evaluator. Untrusted regexes run only in this worker.
 */

'use strict';

const { isMainThread, workerData } = require('worker_threads');

const HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * 2;
const MAX_DIAGNOSTICS = 32;

function safeSource(value) {
  return typeof value === 'string' && /^hookify\.[A-Za-z0-9._-]+\.local\.md$/.test(value)
    ? value
    : 'a Hookify rule';
}

function evaluateCondition(condition, values, diagnostics, source) {
  const value = values[condition.field];
  if (typeof value !== 'string') return false;

  switch (condition.operator) {
    case 'contains':
      return value.includes(condition.pattern);
    case 'equals':
      return value === condition.pattern;
    case 'not_contains':
      return !value.includes(condition.pattern);
    case 'starts_with':
      return value.startsWith(condition.pattern);
    case 'ends_with':
      return value.endsWith(condition.pattern);
    case 'regex_match':
      try {
        return new RegExp(condition.pattern, 'i').test(value);
      } catch {
        addDiagnostic(diagnostics, {
          code: 'HOOKIFY_REGEX_INVALID',
          message: `Hookify skipped ${safeSource(source)}: invalid regular expression.`,
        });
        return false;
      }
    default:
      return false;
  }
}

function addDiagnostic(diagnostics, diagnostic) {
  if (diagnostics.length < MAX_DIAGNOSTICS) {
    diagnostics.push(diagnostic);
    return;
  }
  if (
    diagnostics.length === MAX_DIAGNOSTICS &&
    !diagnostics.some(item => item.code === 'HOOKIFY_DIAGNOSTICS_TRUNCATED')
  ) {
    diagnostics.push({
      code: 'HOOKIFY_DIAGNOSTICS_TRUNCATED',
      message: 'Hookify skipped additional diagnostics because the diagnostic limit was reached.',
    });
  }
}

function evaluateTasks(tasks, values = {}) {
  const matchedIndexes = [];
  const diagnostics = [];
  for (const task of tasks) {
    let matched = true;
    for (const condition of task.conditions) {
      if (!evaluateCondition(condition, values, diagnostics, task.source)) {
        matched = false;
        break;
      }
    }
    if (matched) matchedIndexes.push(task.index);
  }
  return { matchedIndexes, diagnostics };
}

function writeResult(sharedBuffer, result, state = 1) {
  const header = new Int32Array(sharedBuffer, 0, 2);
  const output = Buffer.from(JSON.stringify(result), 'utf8');
  const available = sharedBuffer.byteLength - HEADER_BYTES;
  if (output.length > available) {
    const fallback = Buffer.from(JSON.stringify({
      matchedIndexes: [],
      diagnostics: [{
        code: 'HOOKIFY_REGEX_WORKER_FAILED',
        message: 'Hookify skipped rule evaluation: worker result exceeded its limit.',
      }],
    }), 'utf8');
    new Uint8Array(sharedBuffer, HEADER_BYTES, fallback.length).set(fallback);
    Atomics.store(header, 1, fallback.length);
    Atomics.store(header, 0, 2);
    Atomics.notify(header, 0);
    return;
  }

  new Uint8Array(sharedBuffer, HEADER_BYTES, output.length).set(output);
  Atomics.store(header, 1, output.length);
  Atomics.store(header, 0, state);
  Atomics.notify(header, 0);
}

if (!isMainThread) {
  try {
    writeResult(
      workerData.sharedBuffer,
      evaluateTasks(workerData.tasks, workerData.values)
    );
  } catch {
    writeResult(workerData.sharedBuffer, {
      matchedIndexes: [],
      diagnostics: [{
        code: 'HOOKIFY_REGEX_WORKER_FAILED',
        message: 'Hookify skipped rule evaluation: isolated worker failed.',
      }],
    }, 2);
  }
}

module.exports = {
  evaluateTasks,
  MAX_DIAGNOSTICS,
  writeResult,
};
