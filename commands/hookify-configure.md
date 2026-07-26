---
description: Enable or disable hookify rules interactively
---

Interactively enable or disable existing Hookify rule files.

## Steps

1. Inspect direct, regular `.claude/hookify.*.local.md` files in the current
   project. Do not follow symlinks.
2. Read the current state of each rule and check it against the runtime's
   strict schema.
3. Present valid rules with their enabled / disabled status. Report malformed
   files separately because the runtime skips them.
4. Ask which rules to toggle
5. Update the `enabled:` field in the selected rule files
6. Confirm the changes

Do not silently repair other fields while toggling a rule.
