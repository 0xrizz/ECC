#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  createSafeItoInvocationEnvironment,
  getInvocationCommand,
} = require("./lib/ito-environment");

const SUPPORTED_COMMANDS = Object.freeze([
  "login", "logout", "auth", "find", "status", "evals",
  "serve", "train", "workload-status", "workload-cancel", "workload-cleanup",
]);
const CANONICAL_PACKAGE_PATH = "cli/ito-compute-cli";
const CANONICAL_ENTRY_SEGMENTS = Object.freeze([
  ...CANONICAL_PACKAGE_PATH.split("/"),
  "dist",
  "bin",
  "ito.js",
]);
const EXECUTABLE_OVERRIDE = "ECC_ITO_CLI_EXECUTABLE";
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const NODE_QUALIFICATION_TIMEOUT_MS = 31 * 60 * 1000;

function showHelp() {
  process.stdout.write(`
ECC × Itô local CLI bridge

Usage:
  ecc ito login [--no-browser]
  ecc ito logout
  ecc ito auth
  ecc ito find <all required RFQ options>
  ecc ito status
  ecc ito evals --cluster <id> --live-sixtytwo --nodes <list> --config-dir <dir>
  ecc ito <serve|train> --entitlement <id> <typed workload options>
  ecc ito workload-status --run <id>
  ecc ito workload-cancel --run <id>
  ecc ito workload-cleanup --run <id>
  ecc ito <login|logout|auth|find|status|evals|serve|train|workload-status|workload-cancel|workload-cleanup> --json

The bridge invokes the separately installed canonical Itô CLI and returns its
real stdout, stderr, and exit code unchanged. "ecc ito login" delegates to the
canonical CLI's device authorization. It opens the Itô verification page by default
and persists its device token in macOS Keychain. Pass --no-browser to
suppress that handoff. ECC itself performs no browser automation and adds no
lock, arbitrary-command, direct-SSH, or purchase path.
"ecc ito auth" is validation-only and never starts device login.
"ecc ito logout" asks the canonical CLI to revoke the current device credential
and remove its local copy only after remote revocation is confirmed.

Important:
  - "find" reads live inventory and submits an authenticated RFQ.
  - Obtain explicit buyer authority and every hard constraint before invoking it.
  - "status" reads live RFQ and procurement status.
  - "evals" invokes only the canonical CLI's double-opt-in, pinned
    sixtytwo-cli node-qualification adapter against explicit nodes.
  - Node qualification cannot rent, launch, recover, repair, or purchase.
  - Serve/train require an existing server-verified entitlement and a short-lived
    portal-issued human confirmation in ITO_WORKLOAD_CONFIRMATION_TOKEN.
  - Workload cancellation and cleanup never terminate the paid entitlement.
  - Inventory and RFQs are not reservations; only a returned firm quote is firm.

The canonical package is currently unpublished. Do not clone a private source
repository as an installation requirement. After an official Itô release record
identifies the npm publisher, provenance, and expected integrity, verify those
values and then install the recorded version:
  npm install --global ito-compute-cli@0.1.0

Then set ${EXECUTABLE_OVERRIDE} to the explicit absolute built entry:
  /absolute/npm/root/ito-compute-cli/dist/bin/ito.js

For safety, ECC never discovers this credential-bearing client through PATH.

The same package's MCP server exposes only:
  ito_auth
  ito_find
  ito_status

Configure the MCP command as "node" with this absolute argument:
  /absolute/npm/root/ito-compute-cli/dist/bin/ito-mcp.js

Device login never inherits ITO_API_KEY. The auth, find, and status commands
forward ITO_API_KEY directly when configured; ITO_AUTH_MODE=legacy is not
required. The canonical client stores device credentials in macOS Keychain by
default; file-token fallback remains explicit and must use restrictive settings.
Never put a key or token in arguments, tracked files, or chat.

Live node qualification requires ITO_ENABLE_SIXTYTWO_LIVE=1,
--live-sixtytwo, an explicit node list, and an existing absolute config
directory. It forwards only named SIXTYTWO_API_TOKEN/SIXTYTWO_TOKEN and SSH
agent state; ITO_API_KEY is intentionally excluded. The canonical CLI requires
sixtytwo-cli==0.3.33 and fails closed.
`);
}

function requiredOptionValue(args, option) {
  const indexes = args
    .map((value, index) => (value === option ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length !== 1) {
    throw new Error(`${option} is required exactly once for live node qualification.`);
  }
  const value = args[indexes[0] + 1];
  if (!value?.trim() || value.startsWith("--")) {
    throw new Error(`${option} requires a non-empty value for live node qualification.`);
  }
  return value;
}

function validateTypedOptions(args, requiredOptions, optionalOptions = []) {
  const allowed = new Set([...requiredOptions, ...optionalOptions]);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.has(option) || !value?.trim() || value.startsWith("--")) {
      throw new Error(
        "Serve/train accept only typed workload options; node addresses, SSH material, secrets, positional commands, and arbitrary flags are forbidden."
      );
    }
  }
  for (const option of requiredOptions) requiredOptionValue(args, option);
  for (const option of optionalOptions) {
    const count = args.filter((value) => value === option).length;
    if (count > 1) throw new Error(`${option} may be provided at most once.`);
  }
}

function validateRunLifecycleArgs(args) {
  if (args.length !== 2 || args[0] !== "--run") {
    throw new Error(
      "Workload cancellation and cleanup accept only --run <id>; they do not accept confirmation, entitlement termination, node access, or force options."
    );
  }
  requiredOptionValue(args, "--run");
}

function validateNodeQualificationArgs(args, environment) {
  if (environment.ITO_ENABLE_SIXTYTWO_LIVE !== "1") {
    throw new Error(
      "Live node qualification requires ITO_ENABLE_SIXTYTWO_LIVE=1 before any process is started."
    );
  }
  if (args.filter((value) => value === "--live-sixtytwo").length !== 1) {
    throw new Error(
      "Live node qualification requires --live-sixtytwo exactly once before any process is started."
    );
  }
  requiredOptionValue(args, "--cluster");
  const nodes = requiredOptionValue(args, "--nodes");
  if (!nodes.split(",").every((node) => node.trim().length > 0)) {
    throw new Error("--nodes must explicitly list one or more non-empty nodes.");
  }
  const configDirectory = requiredOptionValue(args, "--config-dir");
  if (!path.isAbsolute(configDirectory)) {
    throw new Error("--config-dir must be an existing absolute directory.");
  }
  try {
    const resolved = fs.realpathSync.native(configDirectory);
    if (
      !fs.statSync(resolved).isDirectory()
      || !fs.statSync(path.join(resolved, "sixtytwo.yaml")).isFile()
    ) {
      throw new Error("invalid qualification configuration");
    }
  } catch {
    throw new Error(
      "--config-dir must exist and contain a regular sixtytwo.yaml before any process is started."
    );
  }
}

function parseArgs(argv, environment = process.env) {
  const args = [...argv];
  if (
    args.length === 0
    || args.includes("--help")
    || args.includes("-h")
  ) {
    return Object.freeze({ help: true, invocationArgs: [] });
  }

  if (environment.ECC_DRY_RUN === "1" || args.includes("--dry-run")) {
    throw new Error(
      "Itô compute has no paper or dry-run success mode. No CLI operation was invoked."
    );
  }

  const jsonIndexes = args
    .map((value, index) => (value === "--json" ? index : -1))
    .filter((index) => index >= 0);
  if (jsonIndexes.length > 1) {
    throw new Error("--json may only be provided once");
  }
  const withoutJson = args.filter((value) => value !== "--json");
  const command = withoutJson.shift();
  if (!SUPPORTED_COMMANDS.includes(command)) {
    throw new Error(
      `Unsupported Itô command "${command || "(missing)"}"; ECC permits only login, logout, auth, find, status, evals, serve, train, workload-status, workload-cancel, and workload-cleanup.`
    );
  }
  if (command === "auth" && withoutJson.includes("--no-browser")) {
    throw new Error("--no-browser is valid only for ecc ito login; auth is validation-only.");
  }
  if (command === "evals") {
    validateNodeQualificationArgs(withoutJson, environment);
  }
  if (command === "serve" || command === "train") {
    if (!environment.ITO_WORKLOAD_CONFIRMATION_TOKEN?.trim()) {
      throw new Error(
        `${command} requires a portal-issued ITO_WORKLOAD_CONFIRMATION_TOKEN before any process is started.`
      );
    }
    validateTypedOptions(withoutJson, [
      "--entitlement", "--artifact-ref", "--image-digest",
      "--max-runtime-seconds", "--max-incremental-cost-usd", "--idempotency-key",
    ], ["--checkpoint-ref"]);
  }
  if (command === "workload-status" || command === "workload-cancel" || command === "workload-cleanup") {
    validateRunLifecycleArgs(withoutJson);
  }

  return Object.freeze({
    help: false,
    invocationArgs: Object.freeze([
      ...(jsonIndexes.length === 1 ? ["--json"] : []),
      command,
      ...withoutJson,
    ]),
  });
}

function resolveItoExecutable(environment = process.env) {
  const configured = environment[EXECUTABLE_OVERRIDE]?.trim();
  if (!configured) {
    throw new Error([
      "The canonical ito-compute-cli is unpublished and ECC will not resolve",
      `a credential-bearing "ito" executable from PATH. Do not clone a private`,
      "repository. Wait for an official Itô release record with verified npm",
      "publisher, provenance, and integrity; install that artifact, then set",
      `${EXECUTABLE_OVERRIDE} to its explicit absolute dist/bin/ito.js path.`,
    ].join(" "));
  }

  if (!path.isAbsolute(configured)) {
    throw new Error(
      `${EXECUTABLE_OVERRIDE} must be an absolute path explicitly configured by the operator.`
    );
  }
  return assertUsableExecutable(configured);
}

function assertUsableExecutable(candidate) {
  let canonicalCandidate;
  try {
    canonicalCandidate = fs.realpathSync.native(candidate);
  } catch {
    throw new Error(
      `${EXECUTABLE_OVERRIDE} does not point to a readable local Itô CLI file.`
    );
  }
  if (!isCanonicalItoEntry(canonicalCandidate)) {
    throw new Error(
      `${EXECUTABLE_OVERRIDE} must point to the canonical dist/bin/ito.js entry.`
    );
  }
  if (!isUsableExecutable(canonicalCandidate)) {
    throw new Error(
      `${EXECUTABLE_OVERRIDE} does not point to a readable local Itô CLI file.`
    );
  }
  return canonicalCandidate;
}

function isCanonicalItoEntry(candidate) {
  const pathSegments = path
    .normalize(candidate)
    .split(path.sep)
    .filter(Boolean);
  if (pathSegments.length < CANONICAL_ENTRY_SEGMENTS.length) return false;
  const candidateTail = pathSegments.slice(-CANONICAL_ENTRY_SEGMENTS.length);
  return candidateTail.every((segment, index) => {
    const expected = CANONICAL_ENTRY_SEGMENTS[index];
    return process.platform === "win32"
      ? segment.toLowerCase() === expected.toLowerCase()
      : segment === expected;
  });
}

function isUsableExecutable(candidate) {
  try {
    const info = fs.statSync(candidate);
    if (!info.isFile()) return false;
    fs.accessSync(candidate, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function buildInvocation(executable, args) {
  if (!isCanonicalItoEntry(executable)) {
    throw new Error(
      `Refusing to invoke an Itô CLI shim. Set ${EXECUTABLE_OVERRIDE} to the absolute dist/bin/ito.js path.`
    );
  }
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([executable, ...args]),
  });
}

function invokeIto(executable, args, environment = process.env) {
  const invocation = buildInvocation(executable, args);
  const command = getInvocationCommand(args);
  const isNodeQualification = command === "evals";
  const isDeviceLogin = command === "login";
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    // Keep policy helpers immutable for callers, but give child-process
    // instrumentation its own mutable copy (for example NODE_V8_COVERAGE).
    env: { ...createSafeItoInvocationEnvironment(environment, args) },
    stdio: isDeviceLogin ? "inherit" : ["pipe", "pipe", "pipe"],
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: isNodeQualification ? NODE_QUALIFICATION_TIMEOUT_MS : undefined,
    shell: false,
    windowsHide: true,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw new Error(`The local Itô CLI could not be started: ${result.error.message}`);
  }
  if (typeof result.status === "number") return result.status;
  if (result.signal) {
    throw new Error(`The local Itô CLI terminated by signal ${result.signal}.`);
  }
  return 1;
}

function main(argv = process.argv.slice(2), environment = process.env) {
  try {
    const parsed = parseArgs(argv, environment);
    if (parsed.help) {
      showHelp();
      return 0;
    }
    const executable = resolveItoExecutable(environment);
    return invokeIto(executable, parsed.invocationArgs, environment);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = Object.freeze({
  CANONICAL_PACKAGE_PATH,
  EXECUTABLE_OVERRIDE,
  NODE_QUALIFICATION_TIMEOUT_MS,
  SUPPORTED_COMMANDS,
  buildInvocation,
  invokeIto,
  main,
  parseArgs,
  resolveItoExecutable,
});
