/**
 * Unit tests for Hookify condition evaluation.
 */

'use strict';

const assert = require('assert');

const {
  evaluateRules,
  extractConditionValue,
  truncateUtf8,
} = require('../../scripts/hooks/hookify-engine');
const {
  evaluateTasks,
  writeResult,
} = require('../../scripts/hooks/hookify-regex-worker');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function rule(overrides = {}) {
  return {
    name: 'test-rule',
    enabled: true,
    event: 'bash',
    action: 'warn',
    toolMatcher: null,
    conditions: [{
      field: 'command',
      operator: 'regex_match',
      pattern: 'npm\\s+publish',
    }],
    message: 'Check the release.',
    source: 'hookify.test-rule.local.md',
    ...overrides,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function runTests() {
  console.log('\n=== Hookify engine tests ===\n');

  let passed = 0;
  let failed = 0;

  if (test('evaluates regexes case-insensitively and requires every condition', () => {
    const rules = [
      rule({
        conditions: [
          { field: 'command', operator: 'regex_match', pattern: 'NPM\\s+PUBLISH' },
          { field: 'command', operator: 'not_contains', pattern: '--dry-run' },
        ],
      }),
    ];
    const matching = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm publish' },
    };
    const notMatching = {
      ...matching,
      tool_input: { command: 'npm publish --dry-run' },
    };

    assert.deepStrictEqual(evaluateRules(rules, matching).matches.map(item => item.name), ['test-rule']);
    assert.deepStrictEqual(evaluateRules(rules, notMatching).matches, []);
  })) passed++; else failed++;

  if (test('supports every documented non-regex operator', () => {
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: '/repo/.env',
        content: 'PREFIX=abc\nAPI_KEY=secret\nSUFFIX=xyz',
      },
    };
    const rules = [
      rule({
        event: 'file',
        conditions: [
          { field: 'file_path', operator: 'ends_with', pattern: '.env' },
          { field: 'content', operator: 'contains', pattern: 'API_KEY' },
          { field: 'content', operator: 'starts_with', pattern: 'PREFIX' },
          { field: 'content', operator: 'ends_with', pattern: 'xyz' },
          { field: 'file_path', operator: 'equals', pattern: '/repo/.env' },
          { field: 'content', operator: 'not_contains', pattern: 'SAFE_PLACEHOLDER' },
        ],
      }),
    ];

    assert.deepStrictEqual(evaluateRules(rules, input).matches.map(item => item.name), ['test-rule']);
  })) passed++; else failed++;

  if (test('extracts safe event fields without reading transcript paths', () => {
    const multiEdit = {
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '/repo/index.js',
        edits: [
          { old_string: 'before one', new_string: 'after one' },
          { old_string: 'before two', new_string: 'after two' },
        ],
      },
    };
    const stop = {
      hook_event_name: 'Stop',
      transcript_path: '/private/transcript.jsonl',
      last_assistant_message: 'Finished safely.',
    };

    assert.strictEqual(extractConditionValue('new_text', multiEdit), 'after one\nafter two');
    assert.strictEqual(extractConditionValue('old_text', multiEdit), 'before one\nbefore two');
    assert.strictEqual(extractConditionValue('content', stop), 'Finished safely.');
    assert.strictEqual(extractConditionValue('transcript', stop), null);
  })) passed++; else failed++;

  if (test('uses the Claude prompt field for user_prompt conditions', () => {
    const input = {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'deploy production now',
      user_prompt: 'this compatibility field must not be trusted',
    };
    const promptRule = rule({
      event: 'prompt',
      conditions: [{
        field: 'user_prompt',
        operator: 'contains',
        pattern: 'deploy production',
      }],
    });

    assert.deepStrictEqual(evaluateRules([promptRule], input).matches.map(item => item.name), ['test-rule']);
  })) passed++; else failed++;

  if (test('honors exact pipe-separated tool matchers', () => {
    const matchedRule = rule({ toolMatcher: 'Bash|Write' });
    const bash = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm publish' },
    };
    const edit = {
      ...bash,
      tool_name: 'Edit',
      tool_input: { command: 'npm publish' },
    };

    assert.strictEqual(evaluateRules([matchedRule], bash).matches.length, 1);
    assert.strictEqual(evaluateRules([matchedRule], edit).matches.length, 0);
  })) passed++; else failed++;

  if (test('does not mutate hook input while evaluating file edits', () => {
    const input = deepFreeze({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: '/repo/index.js',
        old_string: 'old',
        new_string: 'new API_KEY',
      },
    });
    const snapshot = JSON.stringify(input);
    const fileRule = rule({
      event: 'file',
      conditions: [{
        field: 'new_text',
        operator: 'contains',
        pattern: 'API_KEY',
      }],
    });

    assert.strictEqual(evaluateRules([fileRule], input).matches.length, 1);
    assert.strictEqual(JSON.stringify(input), snapshot);
  })) passed++; else failed++;

  if (test('blocking rules inspect complete accepted fields beyond the old 64 KiB boundary', () => {
    const sentinel = 'HOOKIFY_BLOCK_AFTER_64_KIB';
    const longPrefix = 'x'.repeat(70 * 1024);
    const cases = [
      {
        field: 'command',
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: `${longPrefix}${sentinel}` },
        },
      },
      {
        field: 'content',
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: {
            file_path: '/repo/output.txt',
            content: `${longPrefix}${sentinel}`,
          },
        },
      },
      {
        field: 'user_prompt',
        input: {
          hook_event_name: 'UserPromptSubmit',
          prompt: `${longPrefix}${sentinel}`,
        },
      },
      {
        field: 'content',
        input: {
          hook_event_name: 'Stop',
          last_assistant_message: `${longPrefix}${sentinel}`,
        },
      },
      {
        field: 'new_text',
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 'MultiEdit',
          tool_input: {
            file_path: '/repo/output.txt',
            edits: [
              { old_string: 'before', new_string: longPrefix },
              { old_string: 'after', new_string: sentinel },
            ],
          },
        },
      },
    ];

    for (const { field, input } of cases) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(input), 'utf8') < 256 * 1024,
        `${field} fixture must fit within the accepted hook input`
      );
      const blockingRule = rule({
        action: 'block',
        conditions: [{ field, operator: 'contains', pattern: sentinel }],
      });
      assert.deepStrictEqual(
        evaluateRules([blockingRule], input).matches.map(item => item.name),
        ['test-rule'],
        `${field} must be evaluated through its complete accepted value`
      );
    }

    const manyEditsInput = {
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '/repo/output.txt',
        edits: [
          ...Array.from(
            { length: 300 },
            () => ({ old_string: 'before', new_string: 'ordinary edit' })
          ),
          { old_string: 'after', new_string: sentinel },
        ],
      },
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify(manyEditsInput), 'utf8') < 256 * 1024,
      'MultiEdit fixture must fit within the accepted hook input'
    );
    assert.deepStrictEqual(
      evaluateRules([
        rule({
          action: 'block',
          conditions: [{ field: 'new_text', operator: 'contains', pattern: sentinel }],
        }),
      ], manyEditsInput).matches.map(item => item.name),
      ['test-rule'],
      'every edit in an accepted MultiEdit payload must be evaluated'
    );
  })) passed++; else failed++;

  if (test('fails open with a sanitized diagnostic for invalid regex syntax', () => {
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'anything' },
    };
    const result = evaluateRules([
      rule({
        name: 'bad-regex',
        source: 'hookify.bad-regex.local.md',
        conditions: [{ field: 'command', operator: 'regex_match', pattern: '(' }],
      }),
    ], input);

    assert.deepStrictEqual(result.matches, []);
    assert.strictEqual(result.diagnostics.length, 1);
    assert.strictEqual(result.diagnostics[0].code, 'HOOKIFY_REGEX_INVALID');
    assert.ok(!result.diagnostics[0].message.includes('anything'));
  })) passed++; else failed++;

  if (test('a regex timeout preserves an unrelated literal-only block match', () => {
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `literal-hit ${'a'.repeat(30000)}!` },
    };
    const dangerousRules = Array.from({ length: 8 }, (_, index) => rule({
      name: `danger-${index}`,
      source: `hookify.danger-${index}.local.md`,
      conditions: [{ field: 'command', operator: 'regex_match', pattern: '(a+)+$' }],
    }));
    const literalBlock = rule({
      name: 'literal-block',
      action: 'block',
      conditions: [{ field: 'command', operator: 'contains', pattern: 'literal-hit' }],
    });
    const startedAt = Date.now();

    const result = evaluateRules([...dangerousRules, literalBlock], input, { timeoutMs: 100 });
    const elapsed = Date.now() - startedAt;

    assert.deepStrictEqual(result.matches.map(item => item.name), ['literal-block']);
    assert.ok(result.diagnostics.some(item => item.code === 'HOOKIFY_REGEX_TIMEOUT'));
    assert.ok(elapsed < 1500, `regex worker should be terminated promptly, took ${elapsed}ms`);
  })) passed++; else failed++;

  if (test('bounds multibyte fields and handles absent or incompatible field shapes', () => {
    const acceptedValue = `${'a'.repeat(70 * 1024)}界tail`;
    const preservedValue = truncateUtf8(acceptedValue);
    assert.strictEqual(
      Buffer.byteLength(preservedValue, 'utf8'),
      Buffer.byteLength(acceptedValue, 'utf8'),
      'a field within the hook input cap must not be partially evaluated'
    );
    assert.ok(preservedValue.endsWith('界tail'));

    const longValue = `${'a'.repeat(256 * 1024 - 1)}界tail`;
    const truncated = truncateUtf8(longValue);
    assert.ok(Buffer.byteLength(truncated, 'utf8') <= 256 * 1024);
    assert.ok(!truncated.includes('\ufffd'));

    assert.strictEqual(extractConditionValue('command', null), null);
    assert.strictEqual(extractConditionValue('command', []), null);
    assert.strictEqual(extractConditionValue('command', {
      tool_name: 'Read',
      tool_input: {},
    }), null);
    assert.strictEqual(extractConditionValue('file_path', {
      tool_name: 'Read',
      tool_input: {},
    }), null);
    assert.strictEqual(extractConditionValue('new_text', {
      tool_name: 'Read',
      tool_input: {},
    }), null);
    assert.strictEqual(extractConditionValue('old_text', {
      tool_name: 'Write',
      tool_input: { old_text: 'before' },
    }), 'before');
    assert.strictEqual(extractConditionValue('user_prompt', {
      hook_event_name: 'Stop',
      prompt: 'ignored',
    }), null);
    assert.strictEqual(extractConditionValue('content', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: {},
    }), null);
    assert.strictEqual(extractConditionValue('unknown', {}), null);
  })) passed++; else failed++;

  if (test('normalizes Write/Edit fallbacks and skips malformed MultiEdit entries', () => {
    assert.strictEqual(extractConditionValue('content', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { new_text: 'new text' },
    }), 'new text');
    assert.strictEqual(extractConditionValue('content', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { new_string: 'new string' },
    }), 'new string');
    assert.strictEqual(extractConditionValue('new_text', {
      tool_name: 'MultiEdit',
      tool_input: {
        edits: [null, [], { new_string: 42 }, { new_string: 'accepted' }],
      },
    }), 'accepted');
    assert.strictEqual(extractConditionValue('old_text', {
      tool_name: 'MultiEdit',
      tool_input: {},
    }), null);
    const notebookEdit = {
      tool_name: 'NotebookEdit',
      tool_input: {
        notebook_path: '/repo/analysis.ipynb',
        new_source: 'print("safe")',
      },
    };
    assert.strictEqual(
      extractConditionValue('file_path', notebookEdit),
      '/repo/analysis.ipynb'
    );
    assert.strictEqual(extractConditionValue('new_text', notebookEdit), 'print("safe")');
    assert.strictEqual(extractConditionValue('content', notebookEdit), 'print("safe")');
  })) passed++; else failed++;

  if (test('handles empty rule sets, filtered tools, and bounded timeout options', () => {
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm publish' },
    };
    assert.deepStrictEqual(evaluateRules(null, input), { matches: [], diagnostics: [] });
    assert.deepStrictEqual(evaluateRules([], input), { matches: [], diagnostics: [] });
    assert.deepStrictEqual(
      evaluateRules([rule({ toolMatcher: 'Write' })], input),
      { matches: [], diagnostics: [] }
    );
    assert.strictEqual(evaluateRules([rule()], input, { timeoutMs: -1 }).matches.length, 1);
    assert.strictEqual(evaluateRules([rule()], input, { timeoutMs: 5000 }).matches.length, 1);
  })) passed++; else failed++;

  if (test('worker helper bounds result serialization and rejects unsupported operators', () => {
    const evaluated = evaluateTasks([
      {
        index: 0,
        source: '../unsafe-name',
        conditions: [{ field: 'command', operator: 'regex_match', pattern: '(' }],
      },
      {
        index: 1,
        source: 'hookify.operator.local.md',
        conditions: [{ field: 'command', operator: 'unsupported', pattern: 'x' }],
      },
    ], { command: 'anything' });
    assert.deepStrictEqual(evaluated.matchedIndexes, []);
    assert.strictEqual(evaluated.diagnostics[0].code, 'HOOKIFY_REGEX_INVALID');
    assert.ok(evaluated.diagnostics[0].message.includes('a Hookify rule'));

    const shared = new SharedArrayBuffer(512);
    writeResult(shared, {
      matchedIndexes: [],
      diagnostics: [{ code: 'X', message: 'x'.repeat(1000) }],
    });
    const header = new Int32Array(shared, 0, 2);
    assert.strictEqual(Atomics.load(header, 0), 2);
    const bytes = new Uint8Array(shared, 8, Atomics.load(header, 1));
    const result = JSON.parse(Buffer.from(bytes).toString('utf8'));
    assert.strictEqual(result.diagnostics[0].code, 'HOOKIFY_REGEX_WORKER_FAILED');
  })) passed++; else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
