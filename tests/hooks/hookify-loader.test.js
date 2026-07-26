/**
 * Unit tests for the bounded Hookify rule loader.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LIMITS,
  extractDocument,
  loadRuleFile,
  loadRules,
  parseFrontmatter,
  validateRule,
} = require('../../scripts/hooks/hookify-loader');

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
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hookify-loader-'));
  const claudeDir = path.join(projectRoot, '.claude');
  fs.mkdirSync(claudeDir);
  try {
    return fn({ projectRoot, claudeDir });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function writeRule(claudeDir, fileName, frontmatter, message = 'Rule matched.') {
  const source = `---\n${frontmatter}\n---\n${message}\n`;
  fs.writeFileSync(path.join(claudeDir, fileName), source);
}

function runTests() {
  console.log('\n=== Hookify loader tests ===\n');

  let passed = 0;
  let failed = 0;

  if (test('loads enabled pattern and condition rules for the requested event', () => {
    withProject(({ projectRoot, claudeDir }) => {
      writeRule(
        claudeDir,
        'hookify.block-danger.local.md',
        [
          'name: block-danger',
          'enabled: true',
          'event: bash',
          'action: block',
          'pattern: "rm\\\\s+-rf"',
        ].join('\n'),
        'Do not recursively remove this path.'
      );
      writeRule(
        claudeDir,
        'hookify.warn-secrets.local.md',
        [
          'name: warn-secrets',
          'enabled: true',
          'event: all',
          'action: warn',
          'tool_matcher: Write|Edit',
          'conditions:',
          '  - field: file_path',
          '    operator: ends_with',
          '    pattern: .env',
          '  - field: content',
          '    operator: contains',
          '    pattern: API_KEY',
        ].join('\n'),
        'Keep credentials out of source control.'
      );
      writeRule(
        claudeDir,
        'hookify.disabled.local.md',
        [
          'name: disabled',
          'enabled: false',
          'event: bash',
          'pattern: anything',
        ].join('\n')
      );

      const result = loadRules({ projectRoot, event: 'bash' });

      assert.deepStrictEqual(result.rules.map(rule => rule.name), [
        'block-danger',
        'warn-secrets',
      ]);
      assert.deepStrictEqual(result.rules[0].conditions, [{
        field: 'command',
        operator: 'regex_match',
        pattern: 'rm\\s+-rf',
      }]);
      assert.strictEqual(result.rules[1].conditions.length, 2);
      assert.deepStrictEqual(result.diagnostics, []);
    });
  })) passed++; else failed++;

  if (test('simple file patterns preserve the documented file_path matcher', () => {
    const loaded = validateRule({
      name: 'protect-env-files',
      enabled: true,
      event: 'file',
      action: 'block',
      pattern: '\\.env$',
    }, 'Do not edit environment files.', 'hookify.protect-env-files.local.md');

    assert.deepStrictEqual(loaded.conditions, [{
      field: 'file_path',
      operator: 'regex_match',
      pattern: '\\.env$',
    }]);
  })) passed++; else failed++;

  if (test('rejects unknown fields, ambiguous matchers, invalid operators, and event-incompatible fields', () => {
    withProject(({ projectRoot, claudeDir }) => {
      writeRule(
        claudeDir,
        'hookify.unknown.local.md',
        [
          'name: unknown',
          'enabled: true',
          'event: bash',
          'pattern: ls',
          'surprise: nope',
        ].join('\n')
      );
      writeRule(
        claudeDir,
        'hookify.ambiguous.local.md',
        [
          'name: ambiguous',
          'enabled: true',
          'event: bash',
          'pattern: ls',
          'conditions:',
          '  - field: command',
          '    operator: contains',
          '    pattern: npm',
        ].join('\n')
      );
      writeRule(
        claudeDir,
        'hookify.operator.local.md',
        [
          'name: operator',
          'enabled: true',
          'event: file',
          'conditions:',
          '  - field: file_path',
          '    operator: execute',
          '    pattern: .env',
        ].join('\n')
      );
      writeRule(
        claudeDir,
        'hookify.field.local.md',
        [
          'name: field',
          'enabled: true',
          'event: prompt',
          'conditions:',
          '  - field: command',
          '    operator: contains',
          '    pattern: deploy',
        ].join('\n')
      );

      const result = loadRules({ projectRoot, event: null });

      assert.deepStrictEqual(result.rules, []);
      assert.strictEqual(result.diagnostics.length, 4);
      assert.ok(result.diagnostics.every(item => item.code === 'HOOKIFY_RULE_INVALID'));
      assert.ok(result.diagnostics.every(item => !item.message.includes(projectRoot)));
    });
  })) passed++; else failed++;

  if (test('rejects condition list items after the conditions block is closed', () => {
    assert.throws(
      () => parseFrontmatter([
        'name: misplaced-condition',
        'enabled: true',
        'event: file',
        'conditions:',
        '  - field: file_path',
        '    operator: contains',
        '    pattern: src/',
        'action: block',
        '  - field: content',
        '    operator: contains',
        '    pattern: API_KEY',
      ].join('\n')),
      /unsupported YAML structure/
    );
  })) passed++; else failed++;

  if (test('rejects model-facing messages with bidi or invisible controls', () => {
    for (const message of ['Looks safe\u202E.gnirts', 'Invisible\uFEFFjoiner']) {
      assert.throws(
        () => validateRule({
          name: 'bidi-message',
          enabled: true,
          event: 'bash',
          pattern: 'deploy',
        }, message, 'hookify.bidi-message.local.md'),
        /message contains unsafe invisible or bidirectional characters/
      );
    }
  })) passed++; else failed++;

  if (test('rejects traversal names, symlinked files, and a symlinked .claude directory', () => {
    withProject(({ projectRoot, claudeDir }) => {
      const outside = path.join(projectRoot, 'outside.md');
      fs.writeFileSync(outside, [
        '---',
        'name: outside',
        'enabled: true',
        'event: bash',
        'pattern: pwd',
        '---',
        'Outside.',
      ].join('\n'));
      fs.symlinkSync(outside, path.join(claudeDir, 'hookify.link.local.md'));

      const direct = loadRuleFile({
        claudeDir,
        fileName: '../outside.md',
        remainingTotalBytes: LIMITS.maxTotalBytes,
      });
      assert.strictEqual(direct.rule, null);
      assert.strictEqual(direct.diagnostic.code, 'HOOKIFY_RULE_FILE_UNSAFE');

      const linkedFile = loadRules({ projectRoot, event: 'bash' });
      assert.deepStrictEqual(linkedFile.rules, []);
      assert.ok(linkedFile.diagnostics.some(item => item.code === 'HOOKIFY_RULE_FILE_UNSAFE'));

      fs.rmSync(claudeDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(projectRoot, 'elsewhere'));
      fs.symlinkSync(path.join(projectRoot, 'elsewhere'), claudeDir);
      const linkedDirectory = loadRules({ projectRoot, event: 'bash' });
      assert.deepStrictEqual(linkedDirectory.rules, []);
      assert.strictEqual(linkedDirectory.diagnostics[0].code, 'HOOKIFY_RULE_DIRECTORY_UNSAFE');
    });
  })) passed++; else failed++;

  if (test('opens a rule descriptor before path inspection and rejects a later symlink swap', () => {
    withProject(({ projectRoot, claudeDir }) => {
      const fileName = 'hookify.race.local.md';
      const rulePath = path.join(claudeDir, fileName);
      const backupPath = path.join(claudeDir, 'safe-rule.backup');
      const outsidePath = path.join(projectRoot, 'outside-rule.md');
      writeRule(
        claudeDir,
        fileName,
        'name: safe-rule\nenabled: true\nevent: bash\npattern: safe'
      );
      fs.writeFileSync(outsidePath, [
        '---',
        'name: raced-rule',
        'enabled: true',
        'event: bash',
        'pattern: raced',
        '---',
        'This outside rule must never be loaded.',
      ].join('\n'));

      const originalFstatSync = fs.fstatSync;
      const originalLstatSync = fs.lstatSync;
      let descriptorOpened = false;
      let inspectedBeforeOpen = false;
      let swapped = false;
      fs.fstatSync = function markDescriptorOpen(descriptor, ...args) {
        descriptorOpened = true;
        return originalFstatSync.call(fs, descriptor, ...args);
      };
      fs.lstatSync = function inspectWithSwap(target, ...args) {
        if (target === rulePath && !descriptorOpened) {
          inspectedBeforeOpen = true;
        } else if (!swapped && target === rulePath) {
          swapped = true;
          fs.renameSync(rulePath, backupPath);
          fs.symlinkSync(outsidePath, rulePath);
          const linkStat = originalLstatSync.call(fs, target, ...args);
          fs.unlinkSync(rulePath);
          fs.renameSync(backupPath, rulePath);
          return linkStat;
        }
        return originalLstatSync.call(fs, target, ...args);
      };

      try {
        const result = loadRuleFile({
          claudeDir,
          fileName,
          remainingTotalBytes: LIMITS.maxTotalBytes,
          expectedRealDirectory: fs.realpathSync(claudeDir),
        });
        assert.strictEqual(result.rule, null);
        assert.strictEqual(result.diagnostic.code, 'HOOKIFY_RULE_FILE_UNSAFE');
        assert.strictEqual(inspectedBeforeOpen, false);
        assert.strictEqual(swapped, true);
      } finally {
        fs.fstatSync = originalFstatSync;
        fs.lstatSync = originalLstatSync;
        if (fs.existsSync(backupPath) && !fs.existsSync(rulePath)) {
          fs.renameSync(backupPath, rulePath);
        }
      }
    });
  })) passed++; else failed++;

  if (test('caps rule count, individual bytes, total bytes, and pattern length', () => {
    withProject(({ projectRoot, claudeDir }) => {
      for (let index = 0; index < LIMITS.maxRuleFiles + 2; index += 1) {
        writeRule(
          claudeDir,
          `hookify.rule-${String(index).padStart(3, '0')}.local.md`,
          [
            `name: rule-${index}`,
            'enabled: true',
            'event: bash',
            'pattern: safe',
          ].join('\n')
        );
      }
      writeRule(
        claudeDir,
        'hookify.pattern-too-long.local.md',
        [
          'name: pattern-too-long',
          'enabled: true',
          'event: bash',
          `pattern: ${'x'.repeat(LIMITS.maxPatternLength + 1)}`,
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(claudeDir, 'hookify.file-too-large.local.md'),
        Buffer.alloc(LIMITS.maxFileBytes + 1, 0x61)
      );

      const result = loadRules({ projectRoot, event: 'bash' });

      assert.strictEqual(result.rules.length, LIMITS.maxRuleFiles - 2);
      assert.ok(result.totalBytes <= LIMITS.maxTotalBytes);
      assert.ok(result.diagnostics.some(item =>
        item.code === 'HOOKIFY_RULE_LIMIT' &&
        item.message.includes('rule or directory entry count limit reached')
      ));
      assert.ok(result.diagnostics.some(item =>
        item.code === 'HOOKIFY_RULE_LIMIT' &&
        item.message.includes('file exceeds byte limit')
      ));
      assert.ok(result.diagnostics.some(item =>
        item.code === 'HOOKIFY_RULE_INVALID' &&
        item.message.includes('pattern-too-long')
      ));
    });
  })) passed++; else failed++;

  if (test('rejects malformed frontmatter and invalid UTF-8 without throwing', () => {
    withProject(({ projectRoot, claudeDir }) => {
      fs.writeFileSync(
        path.join(claudeDir, 'hookify.frontmatter.local.md'),
        '---\nname: broken\nenabled: true\n'
      );
      fs.writeFileSync(
        path.join(claudeDir, 'hookify.encoding.local.md'),
        Buffer.from([0xff, 0xfe, 0xfd])
      );

      const result = loadRules({ projectRoot, event: 'bash' });

      assert.deepStrictEqual(result.rules, []);
      assert.strictEqual(result.diagnostics.length, 2);
      assert.ok(result.diagnostics.every(item => item.code === 'HOOKIFY_RULE_INVALID'));
    });
  })) passed++; else failed++;

  if (test('reports descriptor read failures separately from schema errors', () => {
    withProject(({ claudeDir }) => {
      const originalReadSync = fs.readSync;
      let readAttempted = false;
      writeRule(
        claudeDir,
        'hookify.read-fails.local.md',
        [
          'name: read-fails',
          'enabled: true',
          'event: bash',
          'pattern: safe',
        ].join('\n')
      );

      try {
        fs.readSync = function readSyncFails() {
          readAttempted = true;
          const error = new Error('sensitive device detail');
          error.code = 'EIO';
          throw error;
        };
        const result = loadRuleFile({
          claudeDir,
          fileName: 'hookify.read-fails.local.md',
          remainingTotalBytes: LIMITS.maxTotalBytes,
          expectedRealDirectory: fs.realpathSync(claudeDir),
        });

        assert.strictEqual(readAttempted, true);
        assert.strictEqual(result.rule, null);
        assert.strictEqual(result.diagnostic.code, 'HOOKIFY_RULE_READ_FAILED');
        assert.ok(!result.diagnostic.message.includes('sensitive device detail'));
      } finally {
        fs.readSync = originalReadSync;
      }
    });
  })) passed++; else failed++;

  if (test('counts malformed file reads against the hard total byte budget', () => {
    withProject(({ projectRoot, claudeDir }) => {
      for (let index = 0; index < 12; index += 1) {
        writeRule(
          claudeDir,
          `hookify.invalid-${String(index).padStart(2, '0')}.local.md`,
          [
            `name: invalid-${index}`,
            'enabled: maybe',
            'event: bash',
            'pattern: anything',
          ].join('\n'),
          'x'.repeat(60 * 1024)
        );
      }

      const result = loadRules({ projectRoot, event: 'bash' });

      assert.deepStrictEqual(result.rules, []);
      assert.ok(result.totalBytes <= LIMITS.maxTotalBytes);
      assert.ok(result.diagnostics.some(item =>
        item.code === 'HOOKIFY_RULE_LIMIT' &&
        item.message.includes('total rule byte limit')
      ));
    });
  })) passed++; else failed++;

  if (test('strict frontmatter parser handles supported quoting and rejects YAML expansion', () => {
    const parsed = parseFrontmatter([
      '# a full-line comment is allowed',
      "name: 'quoted-rule'",
      'enabled: true',
      'event: file',
      'action: warn',
      'conditions:',
      '  - field: file_path',
      '    operator: ends_with',
      "    pattern: '.env'",
    ].join('\n'));
    assert.strictEqual(parsed.name, 'quoted-rule');
    assert.strictEqual(parsed.enabled, true);
    assert.deepStrictEqual(parsed.conditions[0], {
      field: 'file_path',
      operator: 'ends_with',
      pattern: '.env',
    });

    for (const source of [
      'name: "unterminated',
      "name: 'unterminated",
      'name: first\nname: second',
      'conditions: inline',
      'conditions:\n  - unknown: value',
      'conditions:\n    field: command',
      'name: &anchor value',
    ]) {
      assert.throws(() => parseFrontmatter(source));
    }
    assert.throws(() => extractDocument('no frontmatter'));
    assert.throws(() => extractDocument('---\nname: no-close'));
  })) passed++; else failed++;

  if (test('strict schema defaults warn and rejects invalid names, matchers, messages, and condition counts', () => {
    const base = {
      name: 'valid-rule',
      enabled: true,
      event: 'bash',
      pattern: 'safe',
    };
    const valid = validateRule(base, 'Message.', 'hookify.valid-rule.local.md');
    assert.strictEqual(valid.action, 'warn');
    assert.strictEqual(valid.toolMatcher, null);

    for (const frontmatter of [
      { ...base, name: 'Not Kebab' },
      { ...base, enabled: 'true' },
      { ...base, event: 'unknown' },
      { ...base, action: 'execute' },
      { ...base, tool_matcher: 'Bash |Write' },
      { ...base, tool_matcher: '!' },
      { ...base, pattern: undefined },
      { name: 'conditionless', enabled: true, event: 'bash', conditions: [] },
      {
        name: 'too-many',
        enabled: true,
        event: 'bash',
        conditions: Array.from(
          { length: LIMITS.maxConditionCount + 1 },
          () => ({ field: 'command', operator: 'contains', pattern: 'x' })
        ),
      },
    ]) {
      assert.throws(() =>
        validateRule(frontmatter, 'Message.', 'hookify.invalid.local.md')
      );
    }
    assert.throws(() => validateRule(base, '\u0000', 'hookify.invalid.local.md'));
    assert.throws(() =>
      validateRule(base, 'x'.repeat(LIMITS.maxMessageBytes + 1), 'hookify.invalid.local.md')
    );
  })) passed++; else failed++;

  if (test('missing rule directories and non-rule files are harmless', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hookify-empty-'));
    try {
      assert.deepStrictEqual(loadRules({ projectRoot, event: 'bash' }), {
        rules: [],
        diagnostics: [],
        totalBytes: 0,
      });
      fs.mkdirSync(path.join(projectRoot, '.claude'));
      fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}');
      assert.deepStrictEqual(loadRules({ projectRoot, event: 'bash' }).rules, []);
      fs.rmSync(path.join(projectRoot, '.claude'), { recursive: true, force: true });
      fs.writeFileSync(path.join(projectRoot, '.claude'), 'not a directory');
      assert.strictEqual(
        loadRules({ projectRoot, event: 'bash' }).diagnostics[0].code,
        'HOOKIFY_RULE_DIRECTORY_UNSAFE'
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
