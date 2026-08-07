---
name: ito-inference
description: Serve a model on a completed Itô compute booking through the canonical Itô backend. Use after ito-compute has booked GPU nodes and the user wants an OpenAI-compatible endpoint on that metal. Chains off a booking record; ECC implements no serving stack of its own.
---

# Itô Inference

Serve a model on rented Itô metal by delegating to the canonical Itô compute
backend (Layer 0.2). ECC does not implement a parallel serving stack, launch
adapter, or inference server, and does no browser automation. This skill chains
off a **completed booking** produced by `ito-compute`; it never books, reserves,
or spends.

## Prerequisite

A server-verified, active compute entitlement for an already-paid booking or
cluster. Harness memory, a booking id by itself, node IPs, and SSH access are
not authority. Without an entitlement, stop — this skill does not provision.

## Delegation

ECC calls the canonical backend through the `ecc ito` bridge; it never
re-implements serving. Authenticate once with `ecc ito login` (device
authorization; no key in arguments, files, logs, or chat), exactly as
`ito-compute` documents.

```sh
ecc ito serve \
  --entitlement <entitlement-id> \
  --artifact-ref <immutable-model-ref> \
  --image-digest <sha256:image-digest> \
  --max-runtime-seconds <ceiling> \
  --max-incremental-cost-usd <ceiling> \
  --idempotency-key <opaque-id>
```

The user must approve the exact manifest and ceilings in the portal. Supply the
short-lived, single-use result as `ITO_WORKLOAD_CONFIRMATION_TOKEN`; never put
it in arguments, files, logs, or chat. ECC never accepts node addresses, raw
SSH keys, arbitrary commands, or ambient cloud/model credentials here.

## Lifecycle and portal handoff

The start result is a server-issued run reference. Return it to the portal so
the user can follow the audit trail and endpoint readiness. Confirmation is
consumed only by `serve`; do not request or forward it for lifecycle actions.

```sh
ecc ito workload-cancel --run <run-id>
ecc ito workload-cleanup --run <run-id>
```

Cancellation and cleanup are typed control-plane requests and do not terminate
the paid entitlement. Cleanup revokes workload-scoped credentials; ECC never
receives them. Inspect state with `ecc ito workload-status --run <run-id>`.
Logs remain in the portal/control-plane view; never use direct SSH or node
addresses, and do not claim endpoint readiness without functional evidence.

## What the backend does (Layer 0.2)

The desk backend, not ECC, runs the stages, and this skill only reports them:

1. Fabric gate — never launch on unverified metal. Blocks below 80% of
   fabric-expected bus bandwidth; advisory between 80% and 92%; fails loud on
   silent NCCL socket fallback.
2. Weights download and shard to the serving layout (desk-side sharded cache
   keyed by model, quantization, TP degree).
3. Topology plan (AIConfigurator): TP inside the NVLink domain, PP across nodes;
   engine flags emitted as a reviewable file before launch.
4. Launch (vLLM, Dynamo when disaggregating) under systemd, warmup, SLO canary,
   and registration of the endpoint URL and config to Graphiti memory.

## Availability boundary

The canonical CLI contains an executable contract and mock-tested orchestrator,
but production entitlement, confirmation, credential-broker, and executor
adapters are not yet configured. Without them it fails closed before contacting
a node or provider. Never substitute direct SSH, a local runner, or a purchase
endpoint.
