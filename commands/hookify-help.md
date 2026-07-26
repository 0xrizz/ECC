---
description: Get help with the hookify system
---

Display comprehensive hookify documentation.

## Hook System Overview

ECC ships a built-in Node.js runtime that reads project-local
`.claude/hookify.*.local.md` files. The plugin registers that runtime for
PreToolUse, PostToolUse, UserPromptSubmit, and Stop.

### Event Types

- `bash`: runs on Bash tool use; a simple `pattern` matches `command`
- `file`: runs on Write/Edit/MultiEdit/NotebookEdit;
  a simple `pattern` matches `file_path`
- `stop`: runs when Claude finishes a response; a simple `pattern` matches
  the last assistant message
- `prompt`: runs on user message submission; a simple `pattern` matches the
  submitted `prompt`
- `all`: is eligible on all events; conditions whose fields are unavailable
  for the current event do not match

### Rule File Format

Files are stored as `.claude/hookify.{name}.local.md`:

```yaml
---
name: descriptive-name
enabled: true
event: bash|file|stop|prompt|all
action: block|warn
pattern: "regex pattern to match"
tool_matcher: Bash|Write
---
Message to display when rule triggers.
Supports multiple lines.
```

`action` is optional and defaults to `warn`. `tool_matcher` is optional and
uses exact, pipe-separated tool names or `*`.

Use either `pattern` or a non-empty `conditions` list, never both:

```yaml
---
name: block-production-publish
enabled: true
event: bash
action: block
conditions:
  - field: command
    operator: contains
    pattern: npm publish
  - field: command
    operator: not_contains
    pattern: --dry-run
---
Use the release workflow instead.
```

All conditions must match. Supported operators are `regex_match`, `contains`,
`equals`, `not_contains`, `starts_with`, and `ends_with`.
`regex_match` is case-insensitive; the five literal string operators are
case-sensitive.

Condition fields:

- `bash`: `command`
- `file`: `file_path`, `new_text`, `old_text`, `content`
- `prompt`: `user_prompt` (read from Claude Code's `prompt` input)
- `stop`: `content` (the last assistant message)
- `all`: any field above when it exists for the current event

### Enforcement Semantics

- PreToolUse `block` denies the pending tool call.
- UserPromptSubmit `block` rejects the submitted prompt.
- Stop `block` prevents the current stop and gives Claude the reason to
  continue.
- PostToolUse `block` feeds corrective context to Claude. PostToolUse cannot undo
  a tool that already completed.
- PreToolUse, PostToolUse, and UserPromptSubmit `warn` messages reach Claude as
  structured `additionalContext`.
- A Stop warning is a non-blocking `systemMessage` shown to the user. A Stop warning does not make Claude continue; use `action: block` for a corrective
  completion rule.
- Hookify skips recursive Stop evaluation when Claude Code reports
  `stop_hook_active: true`, preventing an always-matching block from creating
  an infinite continuation loop.

Hookify never rewrites or returns modified tool input.

### Safety and Limits

The runtime only inspects direct rule files inside the current project's real
`.claude/` directory. It rejects symlinked directories/files, traversal,
non-regular files, unsupported YAML structures, unknown fields, invalid
operators, and invalid event/field combinations. It does not read `transcript_path`;
Stop rules use the bounded last assistant message.

Every condition field in an accepted hook input is evaluated completely up to
the 256 KiB input limit. A regex timeout does not discard independent
literal-only rule matches.

Limits per invocation:

- 256 directory entries inspected and 64 rule files evaluated
- 64 KiB per rule and 512 KiB total rule bytes
- 512 characters per pattern, 16 conditions, and 4 KiB per message
- 256 KiB hook input and 8 KiB structured output
- one 250 ms total regular-expression deadline

Regular expressions run case-insensitively in a resource-limited worker. A
malformed rule, unsafe file, invalid input, invalid regex, or worker timeout
causes the affected evaluation to fail open. The hook exits successfully and
returns a bounded, event-correct Hookify diagnostic instead of silently writing
the warning to stderr.

### Commands

- `/hookify [description]` creates new rules and auto-analyzes the conversation when no description is given
- `/hookify-list` lists configured rules
- `/hookify-configure` toggles rules on or off

### Pattern Tips

- use JavaScript regex syntax; matching is case-insensitive
- for `bash`, match against the full command string
- for `file`, a simple pattern matches the full file path
- for changed text, use a `content`, `new_text`, or `old_text` condition
- keep regexes narrow even though worker isolation enforces a hard deadline
- test patterns before enabling a blocking rule
