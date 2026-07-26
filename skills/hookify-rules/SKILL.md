---
name: hookify-rules
description: This skill should be used when the user asks to create a hookify rule, write a hook rule, configure hookify, add a hookify rule, or needs guidance on hookify rule syntax and patterns.
---

# Writing Hookify Rules

## Overview

Hookify rules are Markdown files with YAML frontmatter that define patterns to
watch for and messages to show when those patterns match. ECC's built-in Node.js
runtime loads them from the current project `.claude/` directory for
PreToolUse, PostToolUse, UserPromptSubmit, and Stop.

## Rule File Format

### Basic Structure

```markdown
---
name: rule-identifier
enabled: true
event: bash|file|stop|prompt|all
pattern: regex-pattern-here
---

Message to show Claude when this rule triggers.
Can include markdown formatting, warnings, suggestions, etc.
```

### Frontmatter Fields

| Field | Required | Values | Description |
|-------|----------|--------|-------------|
| name | Yes | kebab-case string | Unique identifier (verb-first: warn-*, block-*, require-*) |
| enabled | Yes | true/false | Toggle without deleting |
| event | Yes | bash/file/stop/prompt/all | Which hook event triggers this |
| action | No | warn/block | warn (default) shows a message; block uses the event-specific behavior below |
| pattern | Yes* | regex string | Pattern to match (*or use conditions for complex rules) |
| conditions | Yes* | list | All field/operator/pattern entries must match (*use exactly one of pattern or conditions) |
| tool_matcher | No | `*` or exact names separated by `\|` | Limits a rule to tools such as `Bash` or `Write\|Edit` |

Simple `event: file` patterns match `file_path`.
Matching changed content requires explicit conditions using `content`,
`new_text`, or `old_text`.

### Advanced Format (Multiple Conditions)

```markdown
---
name: warn-env-api-keys
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.env$
  - field: new_text
    operator: contains
    pattern: API_KEY
---

You're adding an API key to a .env file. Ensure this file is in .gitignore!
```

**Condition fields by event:**
- bash: `command`
- file: `file_path`, `new_text`, `old_text`, `content`
- prompt: `user_prompt`
- stop: `content` (the last assistant message; transcripts are never read)
- all: any field above when it exists for the current event; unavailable
  fields do not match

**Operators:** `regex_match`, `contains`, `equals`, `not_contains`, `starts_with`, `ends_with`

All conditions must match for rule to trigger.
`regex_match` is case-insensitive. The literal string operators are
case-sensitive.

## Event Type Guide

### bash Events
Match Bash command patterns:
- Dangerous commands: `rm\s+-rf`, `dd\s+if=`, `mkfs`
- Privilege escalation: `sudo\s+`, `su\s+`
- Permission issues: `chmod\s+777`

### file Events
Simple patterns match the target path for Edit/Write/MultiEdit/NotebookEdit:
- Sensitive files: `\.env$`, `credentials`, `\.pem$`

Use explicit `content`, `new_text`, or `old_text` conditions for changed text:
- Debug code: `console\.log\(`, `debugger`
- Security risks: `eval\(`, `innerHTML\s*=`

### stop Events
Completion checks and reminders against the last assistant message. Pattern
`.*` matches every non-empty or empty final message. Use `action: block` when
Claude must continue; a `warn` Stop rule is only a non-blocking user-visible
system message.

### prompt Events
Match Claude Code's submitted `prompt` through the rule field `user_prompt`.

## Runtime Behavior

- `action: block|warn` is enforced with Claude Code's event-specific structured
  output.
- PreToolUse blocks deny a pending tool call.
- UserPromptSubmit blocks reject the prompt.
- Stop blocks continue the conversation.
- PostToolUse blocks provide corrective feedback only; the completed tool
  cannot be undone.
- Warnings reach Claude through `additionalContext` for PreToolUse,
  PostToolUse, and UserPromptSubmit.
- Stop warnings do not continue Claude. Use a blocking Stop rule for that.
- Recursive Stop evaluation is skipped when `stop_hook_active` is already
  true, so an always-matching block cannot continue forever.
- Hookify never mutates tool input and never reads `transcript_path`.
- Malformed or unsafe rules fail open with a bounded structured diagnostic.

## Pattern Writing Tips

### Regex Basics
- Escape special chars: `.` to `\.`, `(` to `\(`
- `\s` whitespace, `\d` digit, `\w` word char
- `+` one or more, `*` zero or more, `?` optional
- `|` OR operator

### Common Pitfalls
- **Too broad**: `log` matches "login", "dialog" — use `console\.log\(`
- **Too specific**: `rm -rf /tmp` — use `rm\s+-rf`
- **YAML escaping**: Use unquoted patterns; quoted strings need `\\s`

### Testing
```bash
node -e "console.log(new RegExp('your_pattern', 'i').test('test text'))"
```

Regex evaluation runs in a resource-limited worker with one hard total
deadline, but patterns should still be kept focused and short.

## File Organization

- **Location**: the real (not symlinked) `.claude/` directory in the project root
- **Naming**: `.claude/hookify.{descriptive-name}.local.md`
- **Gitignore**: Add `.claude/*.local.md` to `.gitignore`

The loader accepts only direct regular files and a strict frontmatter subset.
Unknown fields, YAML anchors/tags, traversal, symlinks, and non-regular files
are rejected. Current bounds are 64 rules, 64 KiB per file, 512 KiB total,
512 characters per pattern, 16 conditions, and 4 KiB per message.

## Commands

- `/hookify [description]` - Create new rules (auto-analyzes conversation if no args)
- `/hookify-list` - View all rules in table format
- `/hookify-configure` - Toggle rules on/off interactively
- `/hookify-help` - Full documentation

## Quick Reference

Minimum viable rule:
```markdown
---
name: my-rule
enabled: true
event: bash
pattern: dangerous_command
---
Warning message here
```
