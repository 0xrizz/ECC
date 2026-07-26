---
description: Create hooks to prevent unwanted behaviors from conversation analysis or explicit instructions
---

Create project-local rules for ECC's built-in Node.js Hookify runtime by analyzing conversation patterns or explicit user instructions.

## Usage

`/hookify [description of behavior to prevent]`

If no arguments are provided, analyze the current conversation to find behaviors worth preventing.

## Workflow

### Step 1: Gather Behavior Info

- With arguments: parse the user's description of the unwanted behavior
- Without arguments: use the `conversation-analyzer` agent to find:
  - explicit corrections
  - frustrated reactions to repeated mistakes
  - reverted changes
  - repeated similar issues

### Step 2: Present Findings

Show the user:

- behavior description
- proposed event type
- proposed pattern or matcher
- proposed action

### Step 3: Generate Rule Files

For each approved rule, create a file at `.claude/hookify.{name}.local.md`:

```yaml
---
name: rule-name
enabled: true
event: bash|file|stop|prompt|all
action: block|warn
pattern: "regex pattern"
---
Message shown when rule triggers.
```

Use exactly one of `pattern` or `conditions`. For precise matching, use the
condition form:

```yaml
---
name: warn-env-secret
enabled: true
event: file
action: warn
tool_matcher: Write|Edit
conditions:
  - field: file_path
    operator: ends_with
    pattern: .env
  - field: content
    operator: contains
    pattern: API_KEY
---
Keep credentials out of source control.
```

Supported condition operators are `regex_match`, `contains`, `equals`,
`not_contains`, `starts_with`, and `ends_with`. All conditions must match.
The complete schema and event-specific fields are in `/hookify-help`.

### Step 4: Confirm

Report:

- the files created
- whether each rule warns or blocks
- which lifecycle event enforces it
- how to manage it with `/hookify-list` and `/hookify-configure`

Be precise about enforcement. A PreToolUse block prevents the tool call.
A UserPromptSubmit block rejects the prompt. A Stop block makes Claude
continue. A PostToolUse block only supplies corrective feedback because the
tool has already completed.
