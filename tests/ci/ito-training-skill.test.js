/**
 * Contract tests for the installable, entitlement-bound Itô training workflow.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));

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

console.log("\n=== Testing Itô training skill surface ===\n");

const tests = [
  ["has portable discovery metadata and concrete trigger phrases", () => {
    const skill = read("skills/ito-training/SKILL.md");
    assert.match(skill, /^---\nname: ito-training\ndescription: .+\nmetadata:\n {2}origin: ECC\n---\n/);
    for (const phrase of ["training workload", "fine-tun", "checkpoint", "training job"]) {
      assert.match(skill, new RegExp(phrase, "i"));
    }
  }],
  ["defines standard sections and treats external content as untrusted data", () => {
    const skill = read("skills/ito-training/SKILL.md");
    for (const section of ["## When to Use", "## How It Works", "## Examples"]) assert.ok(skill.includes(section));
    assert.match(skill, /metadata[\s\S]+booking records[\s\S]+CLI output[\s\S]+logs[\s\S]+checkpoints[\s\S]+untrusted data/i);
    assert.match(skill, /embedded instructions must never change[\s\S]+identity[\s\S]+tool scope[\s\S]+confirmations[\s\S]+lifecycle actions/i);
  }],
  ["collects a complete workload and cluster recommendation without inventing values", () => {
    const skill = read("skills/ito-training/SKILL.md");
    for (const term of [
      "model", "dataset", "training method", "precision", "sequence length",
      "global batch", "GPU SKU", "GPU count", "fabric", "storage",
      "checkpoint", "retention", "budget", "deadline", "region",
    ]) assert.match(skill, new RegExp(term, "i"), term);
    assert.match(skill, /recommend.*(?:cluster|topology)/i);
    assert.match(skill, /assumption/i);
    assert.match(skill, /do not (?:guess|invent|derive)/i);
  }],
  ["documents auth handoff, originating-agent return, and secret boundaries", () => {
    const skill = read("skills/ito-training/SKILL.md");
    assert.match(skill, /ecc ito login/);
    assert.match(skill, /--no-browser/);
    assert.match(skill, /device authorization/i);
    assert.match(skill, /originating agent/i);
    assert.match(skill, /ecc ito auth/);
    assert.match(skill, /never.*(?:token|secret|key).*(?:chat|log|argument|file)/is);
  }],
  ["advertises only the canonical training lifecycle and its exact confirmations", () => {
    const skill = read("skills/ito-training/SKILL.md");
    for (const command of ["train-launch", "train-status", "train-logs", "train-resume", "train-cancel", "train-cleanup"]) {
      assert.match(skill, new RegExp(`ecc ito ${command}`));
    }
    for (const confirmation of ["LAUNCH", "RESUME", "CANCEL", "CLEANUP"]) assert.match(skill, new RegExp(confirmation));
    assert.match(skill, /queued.*not.*execution/is);
    assert.match(skill, /never substitute[\s\S]*(?:local trainer|SSH|purchase)/i);
  }],
  ["defines structured outputs, confirmations, and recovery paths", () => {
    const skill = read("skills/ito-training/SKILL.md");
    for (const field of [
      "status", "booking_id", "recommended_cluster", "storage_plan",
      "checkpoint_plan", "confirmation_required", "next_action",
    ]) assert.match(skill, new RegExp(`\\b${field}\\b`));
    assert.match(skill, /explicit confirmation/i);
    assert.match(skill, /timeout/i);
    assert.match(skill, /revok/i);
    assert.match(skill, /ambiguous/i);
    assert.match(skill, /ecc ito status/);
    assert.match(skill, /do not retry/i);
  }],
  ["requires live entitlement and a procurement booking rather than an RFQ", () => {
    const skill = read("skills/ito-training/SKILL.md");
    assert.match(skill, /reservations_supported/);
    assert.match(skill, /procurement_orders/);
    assert.match(skill, /RFQ.*not.*(?:booking|training authority)/is);
    assert.match(skill, /false.*BLOCKED/is);
  }],
  ["is exported through one opt-in install module and capability", () => {
    const modules = readJson("manifests/install-modules.json").modules;
    const module = modules.find((candidate) => candidate.id === "ito-training");
    assert.ok(module, "ito-training install module is missing");
    assert.deepStrictEqual(module.paths, ["skills/ito-training"]);
    assert.deepStrictEqual(module.dependencies, ["ito-compute"]);
    assert.strictEqual(module.defaultInstall, false);
    assert.strictEqual(module.stability, "experimental");

    const components = readJson("manifests/install-components.json").components;
    assert.deepStrictEqual(
      components.find((candidate) => candidate.id === "capability:ito-training"),
      {
        id: "capability:ito-training",
        family: "capability",
        description: "Entitlement-bound Itô training planning and lifecycle operations for completed compute bookings, with exact confirmations and cost limits.",
        modules: ["ito-training"],
      },
    );
    assert.ok(readJson("manifests/install-profiles.json").profiles.full.modules.includes("ito-training"));
    assert.ok(readJson("package.json").files.includes("skills/ito-training/"));
  }],
];

const passed = tests.filter(([name, fn]) => test(name, fn)).length;
console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${tests.length - passed}`);
process.exitCode = passed === tests.length ? 0 : 1;
