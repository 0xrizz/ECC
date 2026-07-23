---
name: ito-compute
description: Find and quote GPU compute through Itô, create explicitly labeled paper reservations, inspect RFQ/order/reservation status, and stage paper training jobs. Use when a user asks to get GPUs, find H100/H200 or other accelerator capacity, request a fixed compute rate, reserve or lock a cluster, check Itô compute status, or stage a training run on an Itô cluster.
metadata:
  origin: ECC
---

# Itô Compute

Operate GPU compute procurement through the `ito` CLI and the `ito-compute` MCP
server. Live mode submits real RFQs against the Itô APIs; paper mode is an
explicitly labeled local simulation. The workflow is model- and
provider-neutral: stage any training command for any open-source model, and use
other compute providers or owned hardware without losing workflow
functionality.

## Where the skill lives

The full skill definition and its runtime ship in the `cli/` directory of
`https://github.com/Ito-Markets/agentic-otc-compute-platform` at the
ECC-standard cross-harness skills path:

```text
cli/.agents/skills/ito-compute/SKILL.md
```

That file is the canonical skill: it defines the `ito_auth`, `ito_find`,
`ito_lock`, `ito_status`, and `ito_run` tool workflow, the live/demo mode
boundaries, and the honesty rules agents must preserve.

## Install

1. Clone `https://github.com/Ito-Markets/agentic-otc-compute-platform` and
   build the CLI from its `cli/` directory:

   ```sh
   cd cli
   npm ci
   npm run check
   npm link
   ```

2. Point the harness's skill discovery at the repo's `cli/.agents/skills/`
   directory, or copy `cli/.agents/skills/ito-compute/` into the harness's
   skills directory (for Claude Code: `~/.claude/skills/`).

3. Configure the `ito-compute` stdio MCP server from the repo's README. Paper
   mode requires `ITO_CLI_DEMO=1`; live mode requires `ITO_API_KEY` injected
   into the server environment, never pasted into chat or config committed to
   version control.

## Non-negotiable boundaries

- Preserve `mode`, `simulated`, and `live_api_contacted` from every tool
  result. Never describe a paper quote, reservation, cluster, or job as live.
- Never describe a live RFQ as reserved capacity. Live `lock` and `run` are
  unsupported and fail closed.
- Never fall back from a live API failure to demo fixtures.
- Never expose API keys, authorization headers, or secret values.
- This skill is compute procurement only; do not conflate it with the
  prediction-market `ito-*` research skills or route their workflows through
  these tools.
