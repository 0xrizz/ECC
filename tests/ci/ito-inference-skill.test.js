/** Contract tests for the installable, fail-closed Itô inference skill. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const json = (file) => JSON.parse(read(file));
const skill = read("skills/ito-inference/SKILL.md");

const tests = [
  ["has trigger-rich two-field frontmatter", () => {
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)[1];
    const keys = [...frontmatter.matchAll(/^([a-z_-]+):/gm)].map((match) => match[1]);
    assert.deepStrictEqual(keys, ["name", "description"]);
    for (const phrase of ["deploy", "host", "serve", "run inference", "check", "tear down"]) {
      assert.match(frontmatter, new RegExp(phrase, "i"));
    }
  }],
  ["requires originating booking, exact eligibility, and no capacity selection", () => {
    for (const pattern of [
      /originating agent/, /completed Itô booking/, /cluster id/, /active status/,
      /entitlement/, /do not\s+select another cluster/, /never\s+finds, books, reserves/,
    ]) assert.match(skill, pattern);
  }],
  ["documents device login return and revocation recovery without secrets", () => {
    for (const pattern of [
      /ecc ito auth --json/, /ecc ito login/, /device URL\/code handoff/,
      /return control to the\s+originating agent/, /Timeout, denial, or revocation/,
      /Never place a key, token, or device code/,
    ]) assert.match(skill, pattern);
  }],
  ["documents the complete canonical lifecycle and validation bounds", () => {
    for (const pattern of [
      /inference preflight/, /inference deploy/, /inference status/,
      /inference logs/, /inference stop/, /owner\/model/, /pinned 7–64/,
      /1–168 hours/, /exact current\s+preflight amount/, /idempotency key/,
    ]) assert.match(skill, pattern);
  }],
  ["enforces separate confirmations, ambiguity recovery, and safe cleanup", () => {
    for (const pattern of [
      /separate state-changing actions/, /explicit\s+user confirmation immediately before each/,
      /do not deploy again blindly/, /provider timeout[\s\S]*not cached success/,
      /separate explicit teardown confirmation/, /must not cancel or delete.*compute\s+booking/,
      /cleanup.required=true/,
    ]) assert.match(skill, pattern);
  }],
  ["defines structured results and honest capability-state distinctions", () => {
    for (const field of [
      "status", "phase", "cluster", "authenticated", "eligible", "entitled",
      "model", "revision", "estimated cost", "deployment id", "health",
      "endpoint", "cleanup", "error code", "next action",
    ]) assert.match(skill, new RegExp(field, "i"));
    assert.match(skill, /code existence,\s+local test pass, merge, deployment, and observed live behavior/);
  }],
  ["registers package, module, dependency, capability, and full profile", () => {
    const module = json("manifests/install-modules.json").modules.find((item) => item.id === "ito-inference");
    assert.deepStrictEqual(module.paths, ["skills/ito-inference"]);
    assert.deepStrictEqual(module.dependencies, ["ito-compute"]);
    assert.strictEqual(module.defaultInstall, false);
    assert.strictEqual(module.stability, "experimental");
    assert.ok(module.targets.includes("codex") && module.targets.includes("kimi"));
    assert.deepStrictEqual(json("manifests/install-components.json").components.find((item) => item.id === "capability:ito-inference").modules, ["ito-inference"]);
    assert.ok(json("manifests/install-profiles.json").profiles.full.modules.includes("ito-inference"));
    assert.ok(json("package.json").files.includes("skills/ito-inference/"));
  }],
];

let failed = 0;
for (const [name, test] of tests) {
  try { test(); console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.error(`  ✗ ${name}: ${error.message}`); }
}
console.log(`Passed: ${tests.length - failed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
