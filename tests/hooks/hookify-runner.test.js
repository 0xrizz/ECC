/**
 * Integration tests for the Hookify hook runner and Claude output contracts.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  LIMITS,
  boundOutput,
  buildOutput,
  run,
  validateInput,
} = require('../../scripts/hooks/hookify-runner');

const RUNNER_PATH = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'hookify-runner.js');
const REPO_ROOT = path.join(__dirname, '..', '..');
const HOOKS_PATH = path.join(REPO_ROOT, 'hooks', 'hooks.json');

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

function withProject(fn) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hookify-runner-'));
  const claudeDir = path.join(projectRoot, '.claude');
  fs.mkdirSync(claudeDir);
  try {
    return fn({ projectRoot, claudeDir });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function writeRule(claudeDir, {
  name = 'test-rule',
  enabled = true,
  event = 'bash',
  action = 'warn',
  pattern = 'danger',
  message = 'Correct this behavior.',
}) {
  fs.writeFileSync(
    path.join(claudeDir, `hookify.${name}.local.md`),
    [
      '---',
      `name: ${name}`,
      `enabled: ${enabled}`,
      `event: ${event}`,
      `action: ${action}`,
      `pattern: ${pattern}`,
      '---',
      message,
      '',
    ].join('\n')
  );
}

function invoke(projectRoot, eventName, payload, context = {}) {
  const result = run(JSON.stringify(payload), {
    projectRoot,
    expectedEvent: eventName,
    ...context,
  });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stderr, '');
  return JSON.parse(result.stdout);
}

function runConfiguredCommand(entry, projectRoot, payload, env = {}) {
  return spawnSync(entry.hooks[0].command, {
    shell: true,
    cwd: projectRoot,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      ECC_PLUGIN_ROOT: REPO_ROOT,
      ...env,
    },
    timeout: 10000,
  });
}

function runTests() {
  console.log('\n=== Hookify runner tests ===\n');

  let passed = 0;
  let failed = 0;

  if (test('PreToolUse warnings reach Claude through additionalContext', () => {
    withProject(({ projectRoot, claudeDir }) => {
      writeRule(claudeDir, { message: 'Use a safer command.' });
      const output = invoke(projectRoot, 'PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'danger --now' },
      });

      assert.deepStrictEqual(Object.keys(output), ['hookSpecificOutput']);
      assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.ok(output.hookSpecificOutput.additionalContext.includes('[test-rule]'));
      assert.ok(output.hookSpecificOutput.additionalContext.includes('Use a safer command.'));
      assert.ok(!('updatedInput' in output.hookSpecificOutput), 'Hookify must not mutate tool input');
    });
  })) passed++; else failed++;

  if (test('PreToolUse blocks use permissionDecision deny without changing input', () => {
    withProject(({ projectRoot, claudeDir }) => {
      writeRule(claudeDir, { action: 'block', message: 'This command is prohibited.' });
      const payload = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'danger' },
      };
      const snapshot = JSON.stringify(payload);
      const output = invoke(projectRoot, 'PreToolUse', payload);

      assert.deepStrictEqual(output, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: '**[test-rule]**\nThis command is prohibited.',
        },
      });
      assert.strictEqual(JSON.stringify(payload), snapshot);
    });
  })) passed++; else failed++;

  if (test('PreToolUse blocks inspect accepted command text beyond 64 KiB', () => {
    withProject(({ projectRoot, claudeDir }) => {
      const sentinel = 'HOOKIFY_BLOCK_AFTER_64_KIB';
      writeRule(claudeDir, {
        action: 'block',
        pattern: sentinel,
        message: 'This late command content is prohibited.',
      });
      const payload = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: `${'x'.repeat(70 * 1024)}${sentinel}` },
      };
      assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') < LIMITS.maxInputBytes);

      const output = invoke(projectRoot, 'PreToolUse', payload);

      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(
        output.hookSpecificOutput.permissionDecisionReason.includes(
          'This late command content is prohibited.'
        )
      );
    });
  })) passed++; else failed++;

  if (test('simple file patterns block matching file paths rather than changed content', () => {
    withProject(({ projectRoot, claudeDir }) => {
      writeRule(claudeDir, {
        event: 'file',
        action: 'block',
        pattern: '\\.env$',
        message: 'Environment files are protected.',
      });

      const blocked = invoke(projectRoot, 'PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/.env', content: 'SAFE=value' },
      });
      assert.strictEqual(blocked.hookSpecificOutput.permissionDecision, 'deny');

      const contentOnly = invoke(projectRoot, 'PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/README.md', content: 'mentions .env' },
      });
      assert.deepStrictEqual(contentOnly, {});
    });
  })) passed++; else failed++;

  if (test('PostToolUse block feedback truthfully says the completed tool is not undone', () => {
    withProject(({ projectRoot, claudeDir }) => {
      writeRule(claudeDir, { action: 'block', message: 'Repair the result.' });
      const output = invoke(projectRoot, 'PostToolUse', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'danger' },
        tool_response: { ok: true },
      });

      assert.strictEqual(output.decision, 'block');
      assert.ok(output.reason.includes('already completed'));
      assert.ok(output.reason.includes('cannot undo'));
      assert.ok(output.reason.includes('Repair the result.'));
    });
  })) passed++; else failed++;

  if (test('UserPromptSubmit blocks with the documented top-level decision shape', () => {
    withProject(({ projectRoot, claudeDir }) => {
      writeRule(claudeDir, {
        event: 'prompt',
        action: 'block',
        pattern: 'production',
        message: 'Clarify the deployment target.',
      });
      const output = invoke(projectRoot, 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'deploy production',
      });

      assert.deepStrictEqual(output, {
        decision: 'block',
        reason: '**[test-rule]**\nClarify the deployment target.',
      });
    });
  })) passed++; else failed++;

  if (test('Stop blocks continue Claude but Stop warnings are only non-blocking systemMessage output', () => {
    withProject(({ projectRoot, claudeDir }) => {
      writeRule(claudeDir, {
        name: 'block-stop',
        event: 'stop',
        action: 'block',
        pattern: 'unfinished',
        message: 'Finish verification before stopping.',
      });
      writeRule(claudeDir, {
        name: 'warn-stop',
        event: 'stop',
        action: 'warn',
        pattern: 'unfinished',
        message: 'A non-blocking Stop warning.',
      });
      const output = invoke(projectRoot, 'Stop', {
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'Work is unfinished.',
        transcript_path: '/must/not/be/read.jsonl',
      });

      assert.strictEqual(output.decision, 'block');
      assert.ok(output.reason.includes('Finish verification before stopping.'));
      assert.ok(output.systemMessage.includes('A non-blocking Stop warning.'));

      const recursiveStop = invoke(projectRoot, 'Stop', {
        hook_event_name: 'Stop',
        stop_hook_active: true,
        last_assistant_message: 'Work is unfinished.',
      });
      assert.deepStrictEqual(
        recursiveStop,
        {},
        'an active Stop hook must not re-block and create an infinite continuation loop'
      );

      fs.unlinkSync(path.join(claudeDir, 'hookify.block-stop.local.md'));
      const warningOnly = invoke(projectRoot, 'Stop', {
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'Work is unfinished.',
      });
      assert.deepStrictEqual(Object.keys(warningOnly), ['systemMessage']);
      assert.ok(!('decision' in warningOnly));
      assert.ok(!('hookSpecificOutput' in warningOnly));
    });
  })) passed++; else failed++;

  if (test('never reads transcript_path while evaluating Stop rules', () => {
    withProject(({ projectRoot, claudeDir }) => {
      const transcriptPath = path.join(projectRoot, 'transcript.jsonl');
      fs.writeFileSync(transcriptPath, 'TRANSCRIPT_SENTINEL');
      writeRule(claudeDir, {
        event: 'stop',
        action: 'block',
        pattern: 'TRANSCRIPT_SENTINEL',
      });
      const output = invoke(projectRoot, 'Stop', {
        hook_event_name: 'Stop',
        last_assistant_message: 'Safe final response.',
        transcript_path: transcriptPath,
      });

      assert.deepStrictEqual(output, {});
    });
  })) passed++; else failed++;

  if (test('malformed rules fail open and diagnostics reach Claude without leaking paths', () => {
    withProject(({ projectRoot, claudeDir }) => {
      fs.writeFileSync(
        path.join(claudeDir, 'hookify.broken.local.md'),
        '---\nname: broken\nenabled: maybe\nevent: bash\npattern: danger\n---\nBroken.\n'
      );
      const output = invoke(projectRoot, 'PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'danger' },
      });

      assert.ok(output.hookSpecificOutput.additionalContext.includes('Hookify diagnostic'));
      assert.ok(output.hookSpecificOutput.additionalContext.includes('hookify.broken.local.md'));
      assert.ok(!output.hookSpecificOutput.additionalContext.includes(projectRoot));
      assert.ok(!('permissionDecision' in output.hookSpecificOutput));
    });
  })) passed++; else failed++;

  if (test('rejects mismatched, malformed, and oversized hook inputs with bounded fail-open JSON', () => {
    withProject(({ projectRoot }) => {
      for (const [raw, context] of [
        ['{bad json', { expectedEvent: 'PreToolUse' }],
        [JSON.stringify({ hook_event_name: 'Stop' }), { expectedEvent: 'PreToolUse' }],
        [JSON.stringify({ hook_event_name: 'PreToolUse' }), { expectedEvent: 'PreToolUse', truncated: true }],
      ]) {
        const result = run(raw, { projectRoot, ...context });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stderr, '');
        assert.ok(Buffer.byteLength(result.stdout) <= LIMITS.maxOutputBytes);
        const output = JSON.parse(result.stdout);
        assert.ok(output.hookSpecificOutput.additionalContext.includes('Hookify diagnostic'));
        assert.ok(!('permissionDecision' in output.hookSpecificOutput));
      }
    });
  })) passed++; else failed++;

  if (test('caps combined messages and CLI stdin while always emitting valid structured JSON', () => {
    withProject(({ projectRoot, claudeDir }) => {
      for (let index = 0; index < 12; index += 1) {
        writeRule(claudeDir, {
          name: `warning-${index}`,
          message: `Message ${index}: ${'界'.repeat(1400)}`,
        });
      }
      const output = run(JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'danger' },
      }), {
        projectRoot,
        expectedEvent: 'PreToolUse',
      });
      assert.ok(Buffer.byteLength(output.stdout) <= LIMITS.maxOutputBytes);
      JSON.parse(output.stdout);

      const oversized = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'x'.repeat(LIMITS.maxInputBytes + 1024) },
      });
      const cli = spawnSync(process.execPath, [RUNNER_PATH, 'PreToolUse'], {
        cwd: projectRoot,
        input: oversized,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.strictEqual(cli.status, 0, cli.stderr);
      assert.strictEqual(cli.stderr, '');
      assert.ok(Buffer.byteLength(cli.stdout) <= LIMITS.maxOutputBytes);
      const cliOutput = JSON.parse(cli.stdout);
      assert.ok(cliOutput.hookSpecificOutput.additionalContext.includes('input exceeded'));
    });
  })) passed++; else failed++;

  if (test('hooks.json registers bounded Hookify entrypoints for all four events', () => {
    const hooks = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8')).hooks;
    const pre = hooks.PreToolUse.find(entry => entry.id === 'pre:hookify');
    const stop = hooks.Stop.find(entry => entry.id === 'stop:hookify');
    const prompt = hooks.UserPromptSubmit.find(entry => entry.id === 'prompt:hookify');

    for (const [eventName, entry] of [
      ['PreToolUse', pre],
      ['Stop', stop],
      ['UserPromptSubmit', prompt],
    ]) {
      assert.ok(entry, `${eventName} should register Hookify`);
      assert.ok(entry.hooks[0].command.includes('hookify-runner.js'));
      assert.ok(entry.hooks[0].command.includes(eventName));
      assert.ok(!entry.hooks[0].command.includes('plugin-hook-bootstrap.js'));
      assert.ok(!entry.hooks[0].command.includes('run-with-flags.js'));
      assert.ok(!entry.hooks[0].command.includes("readFileSync(0"));
      assert.ok(!entry.hooks[0].command.includes('spawnSync'));
      assert.ok(entry.hooks[0].timeout > 0);
    }

    const dispatcherSource = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'hooks', 'posttooluse-dispatcher.js'),
      'utf8'
    );
    assert.ok(dispatcherSource.includes("id: 'post:hookify'"));
    assert.ok(dispatcherSource.includes("expectedEvent: 'PostToolUse'"));
    assert.deepStrictEqual(
      hooks.PostToolUse.map(entry => entry.id),
      ['post:dispatcher:sync', 'post:dispatcher:async'],
      'PostToolUse should retain its two-process dispatcher contract'
    );
  })) passed++; else failed++;

  if (test('configured hook commands enforce project rules end to end and ignore payload cwd', () => {
    withProject(({ projectRoot, claudeDir }) => {
      writeRule(claudeDir, {
        event: 'all',
        pattern: 'danger',
        message: 'Configured Hookify warning.',
      });
      const hooks = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8')).hooks;
      const cases = [
        {
          eventName: 'PreToolUse',
          entry: hooks.PreToolUse.find(entry => entry.id === 'pre:hookify'),
          payload: {
            hook_event_name: 'PreToolUse',
            cwd: path.join(projectRoot, 'untrusted-cwd'),
            tool_name: 'Bash',
            tool_input: { command: 'danger' },
          },
          field: 'hookSpecificOutput',
        },
        {
          eventName: 'UserPromptSubmit',
          entry: hooks.UserPromptSubmit.find(entry => entry.id === 'prompt:hookify'),
          payload: {
            hook_event_name: 'UserPromptSubmit',
            cwd: path.join(projectRoot, 'untrusted-cwd'),
            prompt: 'danger',
          },
          field: 'hookSpecificOutput',
        },
        {
          eventName: 'Stop',
          entry: hooks.Stop.find(entry => entry.id === 'stop:hookify'),
          payload: {
            hook_event_name: 'Stop',
            cwd: path.join(projectRoot, 'untrusted-cwd'),
            last_assistant_message: 'danger',
          },
          field: 'systemMessage',
        },
        {
          eventName: 'PostToolUse',
          entry: hooks.PostToolUse.find(entry => entry.id === 'post:dispatcher:sync'),
          payload: {
            hook_event_name: 'PostToolUse',
            cwd: path.join(projectRoot, 'untrusted-cwd'),
            tool_name: 'Bash',
            tool_input: { command: 'danger' },
            tool_response: {},
          },
          field: 'hookSpecificOutput',
          env: {
            ECC_HOOK_PROFILE: 'minimal',
            ECC_DISABLED_HOOKS: 'post:ecc-metrics-bridge',
          },
        },
      ];

      for (const item of cases) {
        const result = runConfiguredCommand(
          item.entry,
          projectRoot,
          item.payload,
          item.env
        );
        assert.strictEqual(result.status, 0, `${item.eventName}: ${result.stderr}`);
        const output = JSON.parse(result.stdout);
        const text = item.field === 'systemMessage'
          ? output.systemMessage
          : output.hookSpecificOutput?.additionalContext;
        assert.ok(
          text.includes('Configured Hookify warning.'),
          `${item.eventName} should return the configured warning`
        );
      }
    });
  })) passed++; else failed++;

  if (test('configured Hookify entrypoints return bounded fail-open output for oversized input', () => {
    withProject(({ projectRoot }) => {
      const hooks = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8')).hooks;
      const cases = [
        {
          eventName: 'PreToolUse',
          entry: hooks.PreToolUse.find(entry => entry.id === 'pre:hookify'),
          payload: {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'x'.repeat(LIMITS.maxInputBytes + 64 * 1024) },
          },
          message(output) {
            return output.hookSpecificOutput?.additionalContext;
          },
        },
        {
          eventName: 'UserPromptSubmit',
          entry: hooks.UserPromptSubmit.find(entry => entry.id === 'prompt:hookify'),
          payload: {
            hook_event_name: 'UserPromptSubmit',
            prompt: 'x'.repeat(LIMITS.maxInputBytes + 64 * 1024),
          },
          message(output) {
            return output.hookSpecificOutput?.additionalContext;
          },
        },
        {
          eventName: 'Stop',
          entry: hooks.Stop.find(entry => entry.id === 'stop:hookify'),
          payload: {
            hook_event_name: 'Stop',
            last_assistant_message: 'x'.repeat(LIMITS.maxInputBytes + 64 * 1024),
          },
          message(output) {
            return output.systemMessage;
          },
        },
      ];

      for (const item of cases) {
        const serializedInput = JSON.stringify(item.payload);
        const result = runConfiguredCommand(item.entry, projectRoot, item.payload);
        assert.strictEqual(result.status, 0, `${item.eventName}: ${result.stderr}`);
        assert.ok(
          Buffer.byteLength(result.stdout) <= LIMITS.maxOutputBytes,
          `${item.eventName} output must stay within the Hookify limit`
        );
        assert.ok(
          Buffer.byteLength(result.stdout) < Buffer.byteLength(serializedInput),
          `${item.eventName} must not echo the oversized input`
        );
        const output = JSON.parse(result.stdout);
        assert.ok(
          item.message(output)?.includes('input exceeded'),
          `${item.eventName} should return an event-correct fail-open diagnostic`
        );
      }
    });
  })) passed++; else failed++;

  if (test('strict hook input validation rejects malformed event-specific fields', () => {
    const cases = [
      [null, 'PreToolUse'],
      [[], 'PreToolUse'],
      [{ hook_event_name: 'Stop' }, 'PreToolUse'],
      [{ hook_event_name: 'PreToolUse', tool_name: '\u0000', tool_input: {} }, 'PreToolUse'],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: [] }, 'PreToolUse'],
      [{ hook_event_name: 'UserPromptSubmit', prompt: 42 }, 'UserPromptSubmit'],
      [{ hook_event_name: 'Stop', last_assistant_message: 42 }, 'Stop'],
      [{ hook_event_name: 'Stop', stop_hook_active: 'false' }, 'Stop'],
    ];
    for (const [payload, eventName] of cases) {
      assert.strictEqual(typeof validateInput(payload, eventName), 'string');
    }
    assert.strictEqual(validateInput({
      hook_event_name: 'Stop',
      last_assistant_message: 'done',
      stop_hook_active: true,
    }, 'Stop'), null);
  })) passed++; else failed++;

  if (test('block plus warning output preserves both event decisions and bounded context', () => {
    const matches = [
      {
        name: 'block-rule',
        action: 'block',
        message: 'Block.',
      },
      {
        name: 'warn-rule',
        action: 'warn',
        message: 'Warn.',
      },
    ];
    const prompt = buildOutput('UserPromptSubmit', matches, []);
    assert.strictEqual(prompt.decision, 'block');
    assert.ok(prompt.hookSpecificOutput.additionalContext.includes('Warn.'));

    const stop = buildOutput('Stop', matches, []);
    assert.strictEqual(stop.decision, 'block');
    assert.ok(stop.systemMessage.includes('Warn.'));

    for (const output of [
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: '\\'.repeat(20000),
          additionalContext: '\\'.repeat(20000),
        },
      },
      {
        decision: 'block',
        reason: '\\'.repeat(20000),
        systemMessage: '\\'.repeat(20000),
      },
    ]) {
      const serialized = boundOutput(output);
      assert.ok(Buffer.byteLength(serialized) <= LIMITS.maxOutputBytes);
      JSON.parse(serialized);
    }
  })) passed++; else failed++;

  if (test('hook IDs select their registered event and non-string input fails open', () => {
    withProject(({ projectRoot }) => {
      const cases = [
        ['pre:hookify', 'PreToolUse', {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: {},
        }],
        ['post:hookify', 'PostToolUse', {
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: {},
        }],
        ['stop:hookify', 'Stop', {
          hook_event_name: 'Stop',
          last_assistant_message: '',
        }],
        ['prompt:hookify', 'UserPromptSubmit', {
          hook_event_name: 'UserPromptSubmit',
          prompt: '',
        }],
      ];
      for (const [hookId, _eventName, payload] of cases) {
        const output = run(JSON.stringify(payload), { projectRoot, hookId });
        assert.strictEqual(output.exitCode, 0);
        JSON.parse(output.stdout);
      }
      const invalid = run(Buffer.from('not accepted'), {
        projectRoot,
        expectedEvent: 'PreToolUse',
      });
      assert.ok(
        JSON.parse(invalid.stdout).hookSpecificOutput.additionalContext.includes(
          'not valid JSON'
        )
      );
    });
  })) passed++; else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
