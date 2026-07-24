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

This file (`skills/ito-compute/SKILL.md` in the ECC repo) is the canonical
skill: it defines the `ito_auth`, `ito_find`, `ito_lock`, `ito_status`, and
`ito_run` tool workflow, the live/demo mode boundaries, and the honesty rules
agents must preserve. The CLI and MCP server that back it ship as the
`ito-compute-cli` npm package (publishing soon; it is bundled with the Itô
runtime today).

## Install

1. Install the CLI once the npm package is live:

   ```sh
   npm i -g ito-compute-cli
   ```

   Until then the skill's paper mode still documents the workflow end to end,
   and Itô design partners get the CLI directly from the Itô team.

2. This skill installs with ECC's normal skill discovery (it lives at
   `skills/ito-compute/`), or copy it into the harness's skills directory
   (for Claude Code: `~/.claude/skills/`).

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
