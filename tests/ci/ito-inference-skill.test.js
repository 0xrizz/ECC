/**
 * Contract tests for the installable, fail-closed Itô inference handoff.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
    return false;
  }
}

console.log("\n=== Testing Itô inference skill lifecycle ===\n");

const results = [
  test("uses the canonical serving trigger and labels the unavailable acceptance contract", () => {
    const skill = read("skills/ito-inference/SKILL.md");
    assert.match(skill, /^name: ito-inference$/m);
    assert.match(skill, /self-host|serve a model|OpenAI-compatible endpoint/i);
    assert.match(skill, /completed booking/i);
    assert.match(skill, /never books, reserves,\s+or spends/i);
    assert.match(skill, /ecc ito serve/i);
    assert.match(skill, /target acceptance contract/i);
    assert.match(skill, /not a live provider adapter or execution claim/i);
    assert.match(skill, /execution is \*\*NOT READY\*\*/i);
    assert.match(skill, /--max-incremental-cost-usd 0/i);
    assert.match(skill, /accounting is not implemented/i);
    assert.match(skill, /rejects every other value before\s+starting the canonical CLI/i);
    assert.match(skill, /never substitute direct SSH, a local runner, or a purchase\s+endpoint/i);
    assert.doesNotMatch(skill, /ssh\s+root@|serve-status\.sh/i);
    for (const gate of [
      /server-verified, active compute entitlement/i,
      /single-use same-origin confirmation/i,
      /idempotency/i,
      /workload-status/i,
      /workload-cancel/i,
      /workload-cleanup/i,
    ]) assert.match(skill, gate);
    assert.doesNotMatch(skill, /--confirmation-token|--api-key|--access-token/i);
  }),
  test("delegates typed serving without confirmation transport", () => {
    const bridge = read("scripts/ito.js");
    const environment = read("scripts/lib/ito-environment.js");
    assert.match(bridge, /SUPPORTED_COMMANDS[\s\S]+?"serve"[\s\S]+?"train"[\s\S]+?"workload-status"/);
    assert.match(bridge, /--max-incremental-cost-usd must be exactly 0/i);
    assert.doesNotMatch(bridge, /ITO_WORKLOAD_CONFIRMATION_TOKEN|X-Ito-Workload-Confirmation/);
    assert.doesNotMatch(environment, /ITO_WORKLOAD_CONFIRMATION_TOKEN/);
    assert.doesNotMatch(`${bridge}\n${environment}`, /--confirm(?:ation)?(?:-token)?\b/i);

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-ito-serve-reject-"));
    try {
      const canonicalDir = path.join(fixtureRoot, "cli", "ito-compute-cli", "dist", "bin");
      fs.mkdirSync(canonicalDir, { recursive: true });
      const marker = path.join(fixtureRoot, "invocation.json");
      const executable = path.join(canonicalDir, "ito.js");
      fs.writeFileSync(executable, `require("fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), confirmation: process.env.ITO_WORKLOAD_CONFIRMATION_TOKEN }));\n`);
      const result = spawnSync(process.execPath, [
        path.join(REPO_ROOT, "scripts", "ecc.js"), "ito", "serve",
        "--entitlement", "ent_test", "--artifact-ref", "model@sha256:test",
        "--image-digest", `sha256:${"d".repeat(64)}`,
        "--max-runtime-seconds", "300", "--max-incremental-cost-usd", "0",
        "--idempotency-key", "idem_test_001",
      ], {
        encoding: "utf8",
        env: { ...process.env, ECC_ITO_CLI_EXECUTABLE: executable },
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const invocation = JSON.parse(fs.readFileSync(marker, "utf8"));
      assert.deepStrictEqual(invocation.argv, [
        "serve", "--entitlement", "ent_test", "--artifact-ref", "model@sha256:test",
        "--image-digest", `sha256:${"d".repeat(64)}`,
        "--max-runtime-seconds", "300", "--max-incremental-cost-usd", "0",
        "--idempotency-key", "idem_test_001",
      ]);
      assert.strictEqual(invocation.confirmation, undefined);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }),
  test("ships canonical inference through the existing opt-in compute module", () => {
    const modules = readJson("manifests/install-modules.json").modules;
    const module = modules.find((candidate) => candidate.id === "ito-compute");
    assert.ok(module, "ito-compute install module is missing");
    assert.deepStrictEqual(module.paths, [
      "skills/ito-compute",
      "skills/ito-inference",
      "skills/ito-training",
    ]);
    assert.deepStrictEqual(module.dependencies, ["platform-configs"]);
    assert.strictEqual(module.defaultInstall, false);
    assert.strictEqual(module.stability, "beta");

    const components = readJson("manifests/install-components.json").components;
    assert.deepStrictEqual(
      components.find((candidate) => candidate.id === "capability:ito-compute"),
      {
        id: "capability:ito-compute",
        family: "capability",
        description: "Authenticated Itô GPU inventory, RFQ, status, device revocation, and explicitly gated node-qualification workflows through the separately installed canonical CLI.",
        modules: ["ito-compute"],
      }
    );

    const profiles = readJson("manifests/install-profiles.json").profiles;
    assert.ok(profiles.full.modules.includes("ito-compute"));

    const packageFiles = readJson("package.json").files;
    assert.ok(packageFiles.includes("skills/ito-inference/"));
    assert.ok(packageFiles.includes("skills/ito-training/"));
  }),
];

const failed = results.filter((passed) => !passed).length;
console.log(`\nPassed: ${results.length - failed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
