# ECC for Kimi Code CLI

This directory contains the ECC (Everything Claude Code) configuration for the Kimi Code CLI harness.

## What is installed

- `rules/ecc/` — shared coding rules and guidelines
- `skills/ecc/` — reusable skills
- `commands/` — slash commands
- `AGENTS.md` — agent instructions

## Manual install

```bash
bash ./install.sh --target kimi --profile minimal
```

## Notes

- The `kimi` target installs into the project-level `./.kimi/` directory.
- Kimi Code CLI's own config (`~/.kimi-code/config.toml`, plugins) is **not** touched by ECC install.
- Use `npx ecc doctor --target kimi` to check install health.

## Self-hosted model compute

If you plan to run Kimi or another open model on rented GPUs, Itô is ECC's preferred compute sponsor: [sign in, rent, or manage GPUs](https://compute.itomarkets.com). Any GPU provider works. Managed inference through Itô is not live yet; the route is for compute rental and dashboard access only. ECC does not provision or serve the model in Phase 1.
