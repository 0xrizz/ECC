---
name: ito-training
description: Plan, launch, monitor, resume, cancel, and clean up an ML training workload on a completed Itô compute booking. Use when the user asks for a training job, fine-tuning or pre-training, a training cluster, or storage and checkpoints.
metadata:
  origin: ECC
---

# Itô Training

Plan and operate a training workload on already-funded Itô metal through the
canonical CLI. This skill never purchases capacity. The server queues accepted
workloads for its configured executor; `queued` is not evidence of execution.

## Authority and prerequisite

Require a completed `ito-compute` booking record containing `booking_id`, node
IPs, SSH readiness, GPU SKU, GPU and node counts, fabric, storage, region, and
booking window. If it is absent or incomplete, return `BLOCKED` and route to
`ito-compute`; do not guess, invent, derive, book, reserve, or provision.

Validate entitlement with the authenticated `ecc ito status --json` result.
Require `reservations_supported: true` and a matching completed record in
`procurement_orders`. An RFQ, quote, draft, or inventory result is not a booking
or training authority. If reservations are reported as false, the procurement
record is absent, or identities/topology do not match, return `BLOCKED` without
calling a state-changing operation.

Planning is read-only. Before any action that could launch a workload,
increase spend, delete checkpoints, release nodes, or end a booking, require
explicit confirmation with the exact action, resource, and cost/destructive
effect. Existing booking authority is not training-launch authority.

## Authentication handoff

When authentication is needed, run `ecc ito login` for device authorization.
It opens the verification page by default; `ecc ito login --no-browser` prints
the handoff without opening it. Pause for the user, then return control to the
originating agent. That agent runs `ecc ito auth` to validate the credential
before continuing. Never expose a token, secret, or key in chat, logs,
arguments, or files. A revoked credential requires a fresh device login; never
silently fall back to another account or credential source.

## Workload specification

Collect these values and label every unresolved value; do not infer hard
constraints from model size or a booking:

- model identifier, parameter count, source revision, license, and weights;
- dataset references, versions, sizes, licenses, access method, and data class;
- training method (pre-training, continued pre-training, SFT, DPO, or RLVR),
  objective, framework, precision, sequence length, global batch, optimizer,
  scheduler, target tokens/steps/epochs, seed, and evaluation gates;
- GPU SKU, GPU count, nodes, GPUs per node, fabric, CPU/RAM, image/runtime,
  region, booking window, budget ceiling, and deadline;
- storage capacity and class for source data, cache, logs, and checkpoints;
- checkpoint cadence, format, upload bandwidth, retention, resume target,
  encryption, destination, and cleanup owner.

## Cluster recommendation

Provide a recommendation, not a reservation. Compare the workload with the
booked topology and state assumptions. Report model/data/optimizer memory,
activation and communication headroom, parallelism (DP/TP/PP/FSDP), expected
checkpoint size and bandwidth, estimated duration, and material risks. Mark the
recommended cluster `INCOMPATIBLE` if it exceeds the completed booking or its
fabric/storage/window. Never broaden region, topology, budget, or deadline.

## Storage and checkpoint plan

Separate immutable inputs, ephemeral cache, durable checkpoints, logs, and
final artifacts. Include capacity math, write/read bandwidth, cadence,
retention count/age, integrity verification, encryption/access boundary,
resume procedure, and cleanup conditions. Cleanup is a proposed plan only;
never delete checkpoints, data, or a booking without explicit confirmation.

## Canonical operations

Use only these CLI verbs; keep JSON output as evidence and never substitute a
local trainer, ad-hoc SSH, browser automation, purchase, or third-party API:

- `ecc ito train-launch ... --confirm "LAUNCH <booking-id>"`
- `ecc ito train-status --run <run-id>`
- `ecc ito train-logs --run <run-id>`
- `ecc ito train-resume --run <run-id> --checkpoint <id> --max-additional-cost-usd <usd> --confirm "RESUME <run-id>"`
- `ecc ito train-cancel --run <run-id> --confirm "CANCEL <run-id>"`
- `ecc ito train-cleanup --run <run-id> --confirm "CLEANUP <run-id>"`

Launch requires the completed workload fields documented above, an exact
booking/topology match, and a positive `--max-cost-usd`. Treat `queued` as an
accepted control-plane request only. Report `running` only when status does.

## Monitoring and recovery

After an ambiguous API/transport response or timeout, inspect `train-status` once
before deciding anything and do not retry a state-changing operation. On auth
revocation, stop and use the device-login handoff. On booking expiry, node
failure, lost SSH access, checkpoint corruption, or failed eval gate, stop and
report the evidence; never launch, restart, repair, release, clean up, or spend.

## Structured output

Return YAML (or an equivalent object) with stable fields:

```yaml
  status: BLOCKED | READY_FOR_REVIEW | QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELLED | CLEANED | INCOMPATIBLE
booking_id: string | null
workload_spec: {}
assumptions: []
recommended_cluster: {}
storage_plan: {}
checkpoint_plan: {}
estimated_cost_usd: null
confirmation_required: []
evidence: []
blockers: []
next_action: string
```

Never infer a lifecycle state from a successful request; use the returned run
state. If `reservations_supported` is false, remain `BLOCKED`.
