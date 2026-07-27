/**
 * Documentation contract tests for the built-in Hookify runtime.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

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

function runTests() {
  console.log('\n=== Hookify runtime documentation tests ===\n');

  let passed = 0;
  let failed = 0;

  if (test('help documents the built-in runtime, limits, and event-correct warning/block behavior', () => {
    const help = read('commands/hookify-help.md');

    for (const requiredText of [
      'built-in Node.js runtime',
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'Stop',
      'PostToolUse cannot undo',
      'Stop warning does not make Claude continue',
      'fail open',
      'worker',
      'does not read `transcript_path`',
    ]) {
      assert.ok(help.includes(requiredText), `Hookify help should mention: ${requiredText}`);
    }
  })) passed++; else failed++;

  if (test('simple file patterns retain the file-path contract', () => {
    const help = read('commands/hookify-help.md');
    const skill = read('skills/hookify-rules/SKILL.md');

    assert.ok(help.includes('simple `pattern` matches `file_path`'));
    assert.ok(help.includes('`regex_match` is case-insensitive'));
    assert.ok(help.includes('literal operators are case-sensitive'));
    assert.ok(skill.includes('Simple `event: file` patterns match `file_path`'));
    assert.ok(skill.includes('changed content requires explicit conditions'));
  })) passed++; else failed++;

  if (test('authoring command and skill document the complete supported schema', () => {
    const authoring = read('commands/hookify.md');
    const skill = read('skills/hookify-rules/SKILL.md');
    const combined = `${authoring}\n${skill}`;

    for (const requiredText of [
      'conditions:',
      'tool_matcher',
      'regex_match',
      'not_contains',
      'starts_with',
      'ends_with',
      'pattern',
      'action: block|warn',
    ]) {
      assert.ok(combined.includes(requiredText), `Hookify authoring docs should mention: ${requiredText}`);
    }
    assert.ok(skill.includes('last assistant message'));
    assert.ok(skill.includes('project `.claude/` directory'));
  })) passed++; else failed++;

  if (test('skill has activation guidance and a regex test command that does not embed user text in code', () => {
    const skill = read('skills/hookify-rules/SKILL.md');
    const testingSection = skill.match(/### Testing\s+```bash\n([\s\S]*?)\n```/);

    assert.ok(skill.includes('## When to Activate'));
    assert.ok(testingSection, 'Hookify skill should include a fenced bash testing example');

    const testingExample = testingSection[1];
    assert.ok(testingExample.includes('readline.createInterface'));
    assert.ok(testingExample.includes("new RegExp(pattern, 'i')"));
    assert.ok(!testingExample.includes("new RegExp('your_pattern'"));
  })) passed++; else failed++;

  if (test('list and configure commands state that malformed rules are skipped rather than enforced', () => {
    const list = read('commands/hookify-list.md');
    const configure = read('commands/hookify-configure.md');

    assert.ok(list.includes('malformed'));
    assert.ok(list.includes('skipped'));
    assert.ok(configure.includes('strict schema'));
  })) passed++; else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
