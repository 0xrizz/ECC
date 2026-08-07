/** Contract tests for the consolidated, fail-closed Itô training handoff. */

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
  ["has portable metadata and concrete training triggers", () => {
    const skill = read("skills/ito-training/SKILL.md");
    assert.match(skill, /^---\nname: ito-training\ndescription: [^\n]+\n---\n/);
    for (const phrase of ["training job", "fine-tuning", "pre-training", "checkpoint"]) {
      assert.match(skill, new RegExp(phrase, "i"), phrase);
    }
  }],
  ["requires typed entitlement-bound training with zero incremental cost", () => {
    const skill = read("skills/ito-training/SKILL.md");
    assert.match(skill, /server-verified, active compute entitlement/i);
    assert.match(skill, /ecc ito train/i);
    for (const option of [
      "--entitlement", "--artifact-ref", "--image-digest", "--max-runtime-seconds",
      "--max-incremental-cost-usd 0", "--idempotency-key", "--checkpoint-ref",
    ]) assert.match(skill, new RegExp(option));
    assert.match(skill, /accounting is not implemented/i);
    assert.match(skill, /rejects every other value before\s+starting the canonical CLI/i);
  }],
  ["keeps confirmation server-side and treats external content as untrusted", () => {
    const skill = read("skills/ito-training/SKILL.md");
    assert.match(skill, /ECC\s+receives no confirmation secret/i);
    assert.match(skill, /never receives or forwards a confirmation token/i);
    assert.match(skill, /untrusted data/i);
    assert.match(skill, /cannot change identity, tool scope, cost ceilings, confirmation rules/i);
    assert.doesNotMatch(skill, /--confirm(?:ation)?(?:-token)?\b/i);
  }],
  ["documents typed lifecycle boundaries without entitlement termination", () => {
    const skill = read("skills/ito-training/SKILL.md");
    for (const command of ["workload-status", "workload-cancel", "workload-cleanup"]) {
      assert.match(skill, new RegExp(`ecc ito ${command}`));
    }
    assert.match(skill, /Neither operation terminates the paid entitlement/i);
    assert.match(skill, /Logs remain portal\/control-plane\s+evidence/i);
    assert.match(skill, /never use direct SSH, SSH material, or node addresses/i);
  }],
  ["labels the backend surface as an unavailable target acceptance contract", () => {
    const skill = read("skills/ito-training/SKILL.md");
    assert.match(skill, /target acceptance contract/i);
    assert.match(skill, /not a live provider adapter or execution claim/i);
    assert.match(skill, /execution is \*\*NOT READY\*\*/i);
    assert.match(skill, /fails closed before contacting\s+a node or provider/i);
  }],
  ["ships through the single opt-in compute module", () => {
    const module = readJson("manifests/install-modules.json").modules
      .find((candidate) => candidate.id === "ito-compute");
    assert.ok(module);
    assert.deepStrictEqual(module.paths, [
      "skills/ito-compute", "skills/ito-inference", "skills/ito-training",
    ]);
    assert.strictEqual(module.defaultInstall, false);
    assert.ok(readJson("package.json").files.includes("skills/ito-training/"));
  }],
];

const passed = tests.filter(([name, fn]) => test(name, fn)).length;
console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${tests.length - passed}`);
process.exitCode = passed === tests.length ? 0 : 1;
