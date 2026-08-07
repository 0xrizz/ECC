---
name: ito-inference
description: Preflight, deploy, observe, and stop self-hosted open-weights inference on an existing eligible and entitled Itô compute cluster. Use when a user asks to deploy, host, serve, run inference, check health or logs, or tear down a Kimi or other open-weights model on Itô GPUs.
---

# Itô Inference

Use only the reviewed canonical `ecc ito inference` lifecycle. This skill never
finds, books, reserves, resizes, purchases, or deletes compute capacity. Never
substitute SSH, systemd, a local vLLM runner, browser automation, or an invented
API/MCP tool.

## Establish intent and authority

Require the originating agent's completed Itô booking record: account, cluster
id, active status, nodes, GPU topology, service start, and entitlement context.
Collect an exact Hugging Face `owner/model`, a pinned 7–64 character hexadecimal
revision, `vllm`, quantization (`none`, `awq`, or `gptq`), and a bounded runtime
of 1–168 hours. Return to the originating agent for missing booking data; do not
select another cluster.

Deployment and teardown are separate state-changing actions. Obtain explicit
user confirmation immediately before each. A compute booking confirmation does
not authorize serving, and a deployment confirmation does not authorize stop.

## Authenticate

Run `ecc ito auth --json`. If authentication is missing, run `ecc ito login`,
present the canonical device URL/code handoff, and return control to the
originating agent while the user completes authorization. Then retry
`ecc ito auth --json`. Never place a key, token, or device code in chat, files,
screenshots, or logs. Timeout, denial, or revocation is not success; repeat the
device flow and never silently switch accounts.

## Preflight

Run the fresh, read-only check:

```text
ecc ito inference preflight --cluster <cluster-id> --model <owner/model> --revision <commit> --engine vllm --quantization <none|awq|gptq> --max-runtime-hours <1-168> --json
```

Proceed only when the response says the authenticated account is entitled, the
exact cluster is active, every contracted node is present and up, service has
started, and the model configuration is valid. Record the returned exact
`estimated_cost_usd`. This is a conservative serving ceiling on already-booked
capacity; it is not authority to buy capacity.

## Deploy

After explicit user confirmation, bind that confirmation to the exact current
preflight amount:

```text
ecc ito inference deploy --cluster <cluster-id> --model <owner/model> --revision <commit> --engine vllm --quantization <none|awq|gptq> --max-runtime-hours <1-168> --confirm-cost-usd <exact-amount> --json
```

Do not round, edit, or reuse a stale amount. The canonical client supplies an
idempotency key and rejects missing/mismatched confirmation. On timeout or an
ambiguous response, do not deploy again blindly; query status using any returned
deployment id and otherwise report the ambiguity for operator reconciliation.

## Observe

Read canonical state; never infer readiness from process exit alone:

```text
ecc ito inference status --deployment <deployment-id> --json
ecc ito inference logs --deployment <deployment-id> --limit <1-500> --json
```

Claim readiness only when status reports the pinned model revision, a healthy
deployment, and its endpoint. Redact credentials and signed endpoint material.
Logs are bounded and read-only. A provider timeout, invalid status, or revoked
authentication is an error, not cached success.

## Stop and verify cleanup

After separate explicit teardown confirmation:

```text
ecc ito inference stop --deployment <deployment-id> --confirm --json
ecc ito inference status --deployment <deployment-id> --json
```

Report cleanup complete only after canonical state is `stopped` with no active
endpoint. Stopping serving must not cancel or delete the underlying compute
booking. If stop is ambiguous, retain `cleanup.required=true` and escalate for
status reconciliation rather than claiming completion.

## Structured result

Return one secret-free object with `status` (`PASS` or `BLOCK`), phase, account
and cluster ids, authenticated/eligible/entitled flags, model and revision,
estimated cost, deployment id, health, endpoint, bounded log evidence, cleanup
required/completed, error code, and next action. Distinguish code existence,
local test pass, merge, deployment, and observed live behavior. Use `PASS` only
for the lifecycle stage actually observed.
