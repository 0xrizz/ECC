---
name: ito-compute
description: Query live GPU inventory, submit an authenticated Itô fixed-rate RFQ, inspect RFQ or procurement status, revoke device credentials, run explicitly gated node qualification, and hand an active entitlement to typed inference or training workflows through the separately installed canonical CLI. Use when a user asks to find GPU capacity, check or revoke Itô access, or rent or purchase GPU compute and needs the supported boundary explained.
---

# Itô Compute

Use the canonical Itô compute CLI or MCP server. ECC does not implement a
parallel client, local simulation, reservation, workload runner, or inference
server. ECC itself does no browser automation.

## Install the canonical local package

`ito-compute-cli` is currently unpublished. Do not clone a private repository
as an installation requirement. Install only after an official Itô release
record identifies the npm publisher, provenance, and expected integrity and
those values match the registry artifact:

```sh
npm install --global ito-compute-cli@0.1.0
```

Set `ECC_ITO_CLI_EXECUTABLE` to the explicit absolute built entry:

```text
/absolute/npm/root/ito-compute-cli/dist/bin/ito.js
```

ECC never discovers this credential-bearing client through `PATH`.
`ecc ito login` performs device authorization and never inherits `ITO_API_KEY`.
The validation-only `auth`, plus `find` and `status`, forward `ITO_API_KEY`
directly when configured; `ITO_AUTH_MODE=legacy` is not required. Never put a
key or token in arguments, tracked files, MCP results, logs, or chat.

## CLI workflow

1. Run `ecc ito login` before the first operation. ECC delegates this to the
   canonical CLI's device authorization, which opens the Itô verification page
   by default and persists a device token in macOS Keychain. Use
   `ecc ito login --no-browser` to suppress the page handoff. ECC itself does no
   browser automation. If the originating agent cannot complete the signed-in
   browser step, hand the exact command to the user; after approval finishes,
   return to the originating task and continue with `ecc ito auth`.
   Device tokens use macOS Keychain by default. File-token fallback is explicit
   and its directory and token file must remain owner-only (0700 and 0600).
2. Run `ecc ito auth` to validate existing credentials; it never starts login
   and rejects `--no-browser`.
3. Before `ecc ito find`, obtain explicit buyer authority to submit an RFQ.
   - Require `gpu`, `count`, whole `days`, `max-rate`, `nodes`,
     `gpus-per-node`, `storage-tb`, `start-window`, `form-factor`,
     `contract-type`, `fabric`, `region`, and the split-fill decision.
   - Require `count == nodes * gpus-per-node`; never derive topology.
   - Use `any` only when the buyer explicitly accepts any fabric or region.
   - Omitted `--allow-split` means false.
4. Run the live RFQ command:

   ```sh
   ecc ito find \
     --gpu h200 \
     --count 8 \
     --nodes 1 \
     --gpus-per-node 8 \
     --days 30 \
     --storage-tb 1 \
     --start-window 2099-08-15 \
     --max-rate 3.00 \
     --form-factor bare_metal \
     --contract-type reservation \
     --fabric infiniband \
     --region us-east-1
   ```

5. Run `ecc ito status` to inspect RFQs and procurement orders.
   After an ambiguous transport failure, check status before repeating `find`.
6. Run `ecc ito logout` when the user explicitly asks to revoke this device.
   The canonical CLI keeps the local credential when remote revocation fails so
   the operator can retry; never delete the token manually as a substitute.

Inventory prices are indicative. An RFQ is not reserved capacity. Treat a rate
as fixed only when the canonical result contains a non-null firm quote.

## Entitlement-to-workload handoff

After procurement, require the canonical control plane to return a
server-verified, active entitlement. An RFQ, booking identifier, portal memory,
node address, or SSH material is not workload authority. The portal must show
the exact immutable manifest, runtime ceiling, incremental-cost ceiling, and
entitlement to the user before issuing a short-lived, single-use
`ITO_WORKLOAD_CONFIRMATION_TOKEN`.

Use `ecc ito serve` or `ecc ito train` only through the corresponding skill.
Confirmation is required only to start a workload. Later lifecycle operations
are typed by the server-issued run reference:

```sh
ecc ito workload-cancel --run <run-id>
ecc ito workload-cleanup --run <run-id>
```

Cancellation requests that execution stop; cleanup revokes workload-scoped
credentials and removes eligible ephemeral artifacts. Neither operation
terminates the paid compute entitlement. Use
`ecc ito workload-status --run <run-id>` for typed state reads. Logs remain
portal/control-plane audit evidence and must never be retrieved by direct SSH.

## Live node qualification

`ecc ito evals` exposes the canonical CLI's narrow live adapter to a separately
installed `sixtytwo-cli==0.3.33`. It does not expose local fixture execution
through ECC.
Require all of the following before invoking it:

- operator authorization to contact the named nodes;
- `ITO_ENABLE_SIXTYTWO_LIVE=1`;
- `--live-sixtytwo`;
- an explicit node list; and
- an existing absolute config directory containing `sixtytwo.yaml`.

```sh
ecc ito evals \
  --cluster clu_prod_example \
  --live-sixtytwo \
  --nodes gpu-01,gpu-02 \
  --config-dir /absolute/path/to/qualification-config
```

The canonical adapter can run only the pinned version check and
`sixtytwo test --full` against the explicit nodes. It cannot rent, launch,
recover, repair, reset, purchase, or order resources. ECC does not forward
`ITO_API_KEY` or model/cloud credentials into node qualification.

## MCP workflow

After installing the verified canonical npm artifact, configure its stdio
server with an absolute path:

```json
{
  "mcpServers": {
    "ito-compute": {
      "command": "node",
      "args": [
        "/absolute/npm/root/ito-compute-cli/dist/bin/ito-mcp.js"
      ]
    }
  }
}
```

The server exposes only:

- `ito_auth`
- `ito_find`
- `ito_status`

`ito_auth` validates existing credentials; it does not start device login. Use
`ito_auth`, gather explicit buyer authority and every hard constraint, call
`ito_find`, then poll with `ito_status` when needed.

## Unsupported operations

The supported client surface cannot lock quotes, reserve capacity, terminate an
entitlement, expose raw cluster credentials, or provide arbitrary node access.
The MCP server does not expose qualification or workloads; use the explicit CLI
commands above. Never use direct SSH or pass node addresses, secret values, or
arbitrary commands through the workload bridge. Do not invent additional tools
or a purchase path. If the canonical adapter is unavailable, report that exact
boundary and stop.
