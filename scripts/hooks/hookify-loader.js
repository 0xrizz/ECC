#!/usr/bin/env node
/**
 * Bounded, project-local loader for `.claude/hookify.*.local.md` rules.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const LIMITS = Object.freeze({
  maxConditionCount: 16,
  maxDirectoryEntries: 256,
  maxFileBytes: 64 * 1024,
  maxMessageBytes: 4096,
  maxPatternLength: 512,
  maxRuleFiles: 64,
  maxToolMatcherLength: 256,
  maxTotalBytes: 512 * 1024,
});

const FILE_NAME_PATTERN = /^hookify\.[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.local\.md$/;
const RULE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const TOP_LEVEL_FIELDS = new Set([
  'name',
  'enabled',
  'event',
  'pattern',
  'conditions',
  'action',
  'tool_matcher',
]);
const CONDITION_FIELDS = new Set(['field', 'operator', 'pattern']);
const EVENTS = new Set(['bash', 'file', 'stop', 'prompt', 'all']);
const ACTIONS = new Set(['warn', 'block']);
const OPERATORS = new Set([
  'regex_match',
  'contains',
  'equals',
  'not_contains',
  'starts_with',
  'ends_with',
]);
const EVENT_FIELDS = Object.freeze({
  bash: new Set(['command']),
  file: new Set(['file_path', 'new_text', 'old_text', 'content']),
  prompt: new Set(['user_prompt']),
  stop: new Set(['content']),
  all: new Set(['command', 'file_path', 'new_text', 'old_text', 'content', 'user_prompt']),
});

function diagnostic(code, fileName, detail) {
  const label = fileName ? ` ${fileName}` : '';
  const suffix = detail ? `: ${detail}` : '.';
  return {
    code,
    message: `Hookify skipped${label}${suffix}`,
  };
}

function hasUnsafeControlCharacters(value, allowNewlines = false) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f) return true;
    if (code >= 0x20) continue;
    if (allowNewlines && (code === 0x09 || code === 0x0a || code === 0x0d)) {
      continue;
    }
    return true;
  }
  return false;
}

function parseQuotedScalar(rawValue) {
  if (rawValue.startsWith('"')) {
    if (!rawValue.endsWith('"')) {
      throw new Error('unterminated double-quoted value');
    }
    try {
      return JSON.parse(rawValue);
    } catch {
      throw new Error('invalid double-quoted escape');
    }
  }

  if (rawValue.startsWith("'")) {
    if (!rawValue.endsWith("'")) {
      throw new Error('unterminated single-quoted value');
    }
    return rawValue.slice(1, -1).replace(/''/g, "'");
  }

  return rawValue;
}

function parseScalar(rawValue) {
  const value = rawValue.trim();
  if (!value) throw new Error('empty scalar');
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[&*!][A-Za-z0-9_-]+(?:\s|$)/.test(value)) {
    throw new Error('YAML tags, anchors, and aliases are not supported');
  }
  return parseQuotedScalar(value);
}

function setUnique(target, key, value) {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    throw new Error(`duplicate field ${key}`);
  }
  target[key] = value;
}

function parseFrontmatter(frontmatterText) {
  const result = {};
  const lines = frontmatterText.split('\n');
  let conditions = null;
  let currentCondition = null;

  for (const originalLine of lines) {
    const line = originalLine.endsWith('\r')
      ? originalLine.slice(0, -1)
      : originalLine;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const topLevel = line.match(/^([a-z_]+):(?:[ \t]*(.*))?$/);
    if (topLevel) {
      const [, key, rawValue = ''] = topLevel;
      if (!TOP_LEVEL_FIELDS.has(key)) throw new Error(`unknown field ${key}`);
      if (key === 'conditions') {
        if (rawValue.trim()) throw new Error('conditions must be a list');
        if (conditions !== null) throw new Error('duplicate field conditions');
        conditions = [];
        result.conditions = conditions;
        currentCondition = null;
      } else {
        setUnique(result, key, parseScalar(rawValue));
        currentCondition = null;
      }
      continue;
    }

    const listStart = line.match(/^ {2}- ([a-z_]+):(?:[ \t]*(.*))?$/);
    if (listStart && conditions) {
      const [, key, rawValue = ''] = listStart;
      if (!CONDITION_FIELDS.has(key)) throw new Error(`unknown condition field ${key}`);
      currentCondition = {};
      conditions.push(currentCondition);
      setUnique(currentCondition, key, parseScalar(rawValue));
      continue;
    }

    const continuation = line.match(/^ {4}([a-z_]+):(?:[ \t]*(.*))?$/);
    if (continuation && currentCondition) {
      const [, key, rawValue = ''] = continuation;
      if (!CONDITION_FIELDS.has(key)) throw new Error(`unknown condition field ${key}`);
      setUnique(currentCondition, key, parseScalar(rawValue));
      continue;
    }

    throw new Error('unsupported YAML structure');
  }

  return result;
}

function extractDocument(source) {
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') throw new Error('missing opening frontmatter delimiter');
  const closingIndex = lines.indexOf('---', 1);
  if (closingIndex < 0) throw new Error('missing closing frontmatter delimiter');

  return {
    frontmatter: parseFrontmatter(lines.slice(1, closingIndex).join('\n')),
    message: lines.slice(closingIndex + 1).join('\n').trim(),
  };
}

function validateString(value, field, options = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (hasUnsafeControlCharacters(value, options.allowNewlines === true)) {
    throw new Error(`${field} contains control characters`);
  }
  if (options.maxLength && value.length > options.maxLength) {
    throw new Error(`${field} exceeds its length limit`);
  }
  return value;
}

function validateToolMatcher(value) {
  if (value === undefined) return null;
  validateString(value, 'tool_matcher', { maxLength: LIMITS.maxToolMatcherLength });
  if (value === '*') return value;

  const tools = value.split('|');
  if (
    tools.length === 0 ||
    tools.some(tool => tool !== tool.trim() || !TOOL_NAME_PATTERN.test(tool))
  ) {
    throw new Error('tool_matcher must contain exact pipe-separated tool names');
  }
  return value;
}

function inferredField(event) {
  if (event === 'bash') return 'command';
  if (event === 'file') return 'file_path';
  if (event === 'prompt') return 'user_prompt';
  return 'content';
}

function validateCondition(condition, event) {
  if (
    !condition ||
    typeof condition !== 'object' ||
    Array.isArray(condition) ||
    Object.keys(condition).length !== CONDITION_FIELDS.size ||
    ![...CONDITION_FIELDS].every(field => Object.prototype.hasOwnProperty.call(condition, field))
  ) {
    throw new Error('each condition requires only field, operator, and pattern');
  }

  const field = validateString(condition.field, 'condition field');
  const operator = validateString(condition.operator, 'condition operator');
  const pattern = validateString(condition.pattern, 'condition pattern', {
    maxLength: LIMITS.maxPatternLength,
  });
  if (!EVENT_FIELDS[event].has(field)) {
    throw new Error(`condition field ${field} is not valid for event ${event}`);
  }
  if (!OPERATORS.has(operator)) throw new Error(`unsupported condition operator ${operator}`);
  return { field, operator, pattern };
}

function validateRule(frontmatter, message, source) {
  const keys = Object.keys(frontmatter);
  for (const field of ['name', 'enabled', 'event']) {
    if (!keys.includes(field)) throw new Error(`missing required field ${field}`);
  }

  const name = validateString(frontmatter.name, 'name', { maxLength: 80 });
  if (!RULE_NAME_PATTERN.test(name)) {
    throw new Error('name must be lower-case kebab-case');
  }
  if (typeof frontmatter.enabled !== 'boolean') {
    throw new Error('enabled must be true or false');
  }

  const event = validateString(frontmatter.event, 'event');
  if (!EVENTS.has(event)) throw new Error(`unsupported event ${event}`);
  const action = frontmatter.action === undefined
    ? 'warn'
    : validateString(frontmatter.action, 'action');
  if (!ACTIONS.has(action)) throw new Error(`unsupported action ${action}`);

  const hasPattern = Object.prototype.hasOwnProperty.call(frontmatter, 'pattern');
  const hasConditions = Object.prototype.hasOwnProperty.call(frontmatter, 'conditions');
  if (hasPattern === hasConditions) {
    throw new Error('define exactly one of pattern or conditions');
  }

  let conditions;
  let pattern = null;
  if (hasPattern) {
    pattern = validateString(frontmatter.pattern, 'pattern', {
      maxLength: LIMITS.maxPatternLength,
    });
    conditions = [{
      field: inferredField(event),
      operator: 'regex_match',
      pattern,
    }];
  } else {
    if (
      !Array.isArray(frontmatter.conditions) ||
      frontmatter.conditions.length === 0 ||
      frontmatter.conditions.length > LIMITS.maxConditionCount
    ) {
      throw new Error(`conditions must contain 1-${LIMITS.maxConditionCount} items`);
    }
    conditions = frontmatter.conditions.map(condition => validateCondition(condition, event));
  }

  validateString(message, 'message', { allowNewlines: true });
  if (Buffer.byteLength(message, 'utf8') > LIMITS.maxMessageBytes) {
    throw new Error('message exceeds its byte limit');
  }

  return Object.freeze({
    name,
    enabled: frontmatter.enabled,
    event,
    action,
    pattern,
    conditions: Object.freeze(conditions.map(condition => Object.freeze(condition))),
    toolMatcher: validateToolMatcher(frontmatter.tool_matcher),
    message,
    source,
  });
}

function readFileBounded(fileDescriptor, maxBytes) {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(
      fileDescriptor,
      buffer,
      offset,
      buffer.length - offset,
      null
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return {
    buffer: buffer.subarray(0, Math.min(offset, maxBytes)),
    exceeded: offset > maxBytes,
  };
}

function loadRuleFile({
  claudeDir,
  fileName,
  remainingTotalBytes,
  expectedRealDirectory,
}) {
  const remainingBytes =
    Number.isInteger(remainingTotalBytes) && remainingTotalBytes >= 0
      ? Math.min(remainingTotalBytes, LIMITS.maxTotalBytes)
      : LIMITS.maxTotalBytes;
  let consumedBytes = 0;
  if (
    typeof claudeDir !== 'string' ||
    typeof fileName !== 'string' ||
    path.basename(fileName) !== fileName ||
    !FILE_NAME_PATTERN.test(fileName)
  ) {
    return {
      rule: null,
      diagnostic: diagnostic(
        'HOOKIFY_RULE_FILE_UNSAFE',
        FILE_NAME_PATTERN.test(String(fileName || '')) ? fileName : null,
        'unsafe rule path rejected'
      ),
      bytesRead: 0,
    };
  }

  const filePath = path.join(claudeDir, fileName);
  let fileDescriptor;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    try {
      fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
      if (
        error &&
        ['ELOOP', 'EMLINK', 'ENOENT', 'ENOTDIR'].includes(error.code)
      ) {
        return {
          rule: null,
          diagnostic: diagnostic('HOOKIFY_RULE_FILE_UNSAFE', fileName, 'not a regular file'),
          bytesRead: 0,
        };
      }
      throw error;
    }
    const fileStat = fs.fstatSync(fileDescriptor);
    if (!fileStat.isFile()) {
      return {
        rule: null,
        diagnostic: diagnostic('HOOKIFY_RULE_FILE_UNSAFE', fileName, 'not a regular file'),
        bytesRead: 0,
      };
    }

    const linkStat = fs.lstatSync(filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      return {
        rule: null,
        diagnostic: diagnostic('HOOKIFY_RULE_FILE_UNSAFE', fileName, 'not a regular file'),
        bytesRead: 0,
      };
    }
    if (
      fileStat.dev !== linkStat.dev ||
      fileStat.ino !== linkStat.ino ||
      fileStat.mode !== linkStat.mode ||
      fileStat.size !== linkStat.size ||
      fileStat.mtimeMs !== linkStat.mtimeMs
    ) {
      return {
        rule: null,
        diagnostic: diagnostic(
          'HOOKIFY_RULE_FILE_UNSAFE',
          fileName,
          'rule identity changed during evaluation'
        ),
        bytesRead: 0,
      };
    }

    const realDirectory = fs.realpathSync(claudeDir);
    if (expectedRealDirectory && realDirectory !== expectedRealDirectory) {
      return {
        rule: null,
        diagnostic: diagnostic(
          'HOOKIFY_RULE_FILE_UNSAFE',
          fileName,
          'project .claude changed during evaluation'
        ),
        bytesRead: 0,
      };
    }
    const realFile = fs.realpathSync(filePath);
    if (
      path.dirname(realFile) !== realDirectory ||
      realFile !== path.join(realDirectory, fileName)
    ) {
      return {
        rule: null,
        diagnostic: diagnostic(
          'HOOKIFY_RULE_FILE_UNSAFE',
          fileName,
          'resolved outside project .claude'
        ),
        bytesRead: 0,
      };
    }
    if (fileStat.size > LIMITS.maxFileBytes) {
      return {
        rule: null,
        diagnostic: diagnostic('HOOKIFY_RULE_LIMIT', fileName, 'file exceeds byte limit'),
        bytesRead: 0,
      };
    }
    if (fileStat.size > remainingBytes) {
      return {
        rule: null,
        diagnostic: diagnostic('HOOKIFY_RULE_LIMIT', fileName, 'total rule byte limit reached'),
        bytesRead: 0,
      };
    }

    const read = readFileBounded(
      fileDescriptor,
      Math.min(LIMITS.maxFileBytes, remainingBytes)
    );
    consumedBytes = read.buffer.length;
    if (read.exceeded) {
      return {
        rule: null,
        diagnostic: diagnostic('HOOKIFY_RULE_LIMIT', fileName, 'rule byte limit reached'),
        bytesRead: consumedBytes,
      };
    }

    const source = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer);
    const document = extractDocument(source);
    return {
      rule: validateRule(document.frontmatter, document.message, fileName),
      diagnostic: null,
      bytesRead: consumedBytes,
    };
  } catch {
    return {
      rule: null,
      diagnostic: diagnostic('HOOKIFY_RULE_INVALID', fileName, 'invalid rule schema or encoding'),
      bytesRead: consumedBytes,
    };
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {
        // The descriptor is already unusable; the rule still fails open.
      }
    }
  }
}

function listRuleNames(claudeDir) {
  const names = [];
  let scanned = 0;
  let exceededDirectoryLimit = false;
  const directory = fs.opendirSync(claudeDir);
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      scanned += 1;
      if (scanned > LIMITS.maxDirectoryEntries) {
        exceededDirectoryLimit = true;
        break;
      }
      if (FILE_NAME_PATTERN.test(entry.name)) names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }

  names.sort();
  return {
    names: names.slice(0, LIMITS.maxRuleFiles),
    exceeded: exceededDirectoryLimit || names.length > LIMITS.maxRuleFiles,
  };
}

function loadRules(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const claudeDir = path.join(projectRoot, '.claude');
  const diagnostics = [];
  const rules = [];
  let totalBytes = 0;
  let realClaudeDir;

  try {
    const directoryStat = fs.lstatSync(claudeDir);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return {
        rules,
        diagnostics: [
          diagnostic(
            'HOOKIFY_RULE_DIRECTORY_UNSAFE',
            null,
            'project .claude must be a real directory'
          ),
        ],
        totalBytes,
      };
    }
    // Parent project paths can themselves have platform aliases (for example
    // `/var` -> `/private/var` on macOS). Compare real paths while still
    // requiring `.claude` itself to be the direct child checked by lstat.
    const realProjectRoot = fs.realpathSync(projectRoot);
    realClaudeDir = fs.realpathSync(claudeDir);
    if (realClaudeDir !== path.join(realProjectRoot, '.claude')) {
      return {
        rules,
        diagnostics: [
          diagnostic(
            'HOOKIFY_RULE_DIRECTORY_UNSAFE',
            null,
            'project .claude resolved outside the project'
          ),
        ],
        totalBytes,
      };
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { rules, diagnostics, totalBytes };
    return {
      rules,
      diagnostics: [
        diagnostic(
          'HOOKIFY_RULE_DIRECTORY_UNSAFE',
          null,
          'project .claude could not be inspected'
        ),
      ],
      totalBytes,
    };
  }

  let listed;
  try {
    listed = listRuleNames(claudeDir);
  } catch {
    return {
      rules,
      diagnostics: [
        diagnostic('HOOKIFY_RULE_DIRECTORY_UNSAFE', null, 'project .claude could not be read'),
      ],
      totalBytes,
    };
  }
  if (listed.exceeded) {
    diagnostics.push(
      diagnostic('HOOKIFY_RULE_LIMIT', null, 'rule or directory entry count limit reached')
    );
  }

  for (const fileName of listed.names) {
    const loaded = loadRuleFile({
      claudeDir,
      fileName,
      remainingTotalBytes: LIMITS.maxTotalBytes - totalBytes,
      expectedRealDirectory: realClaudeDir,
    });
    totalBytes += loaded.bytesRead;
    if (loaded.diagnostic) {
      diagnostics.push(loaded.diagnostic);
      continue;
    }
    const rule = loaded.rule;
    if (!rule.enabled) continue;
    if (options.event && rule.event !== 'all' && rule.event !== options.event) continue;
    if (!options.event && rule.event !== 'all') continue;
    rules.push(rule);
  }

  return { rules, diagnostics, totalBytes };
}

module.exports = {
  LIMITS,
  extractDocument,
  loadRuleFile,
  loadRules,
  parseFrontmatter,
  validateRule,
};
