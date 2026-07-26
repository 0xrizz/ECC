---
description: List all configured hookify rules
---

Find and display project-local Hookify rule files and their runtime status.

## Steps

1. Find direct, regular `.claude/hookify.*.local.md` files in the current
   project's `.claude/` directory. Do not follow symlinks.
2. Read each file's frontmatter:
   - `name`
   - `enabled`
   - `event`
   - `action`
   - `pattern`
   - `conditions`
   - `tool_matcher`
3. Display them as a table:

| Rule | Enabled | Event | Action | Matcher | File |
|------|---------|-------|--------|---------|------|

4. Report malformed or unsafe files separately. They are skipped by the
   runtime and are not enforced.
5. Show the valid/enabled count and remind the user that
   `/hookify-configure` can change state later.
