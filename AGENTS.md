# paperless-codex agent rules

Before substantial work:

1. Read `README.md`, `.env.example`, and relevant workflow/deployment files.
2. Read `.agent/project.yaml`.
3. Read the canonical shared rules from `Juloc/agent-control/AGENTS.md` on `main` using available GitHub access.
4. Inspect relevant Issues and pull requests plus current coordination in `Juloc/agent-control` issue #1 before claiming work.
5. Create and re-check a coordination claim before substantial edits and release it when work is complete.

## Product and security boundaries

- This service is a sidecar for Paperless-ngx; do not fork or modify Paperless itself as part of normal feature work.
- Codex consumes rendered document pages/images. Do not silently replace that with Paperless OCR text as the primary AI input.
- Keep Codex execution sandboxed and do not enable the shell tool for document scans.
- Never commit Paperless API tokens, bridge keys, ChatGPT/Codex credentials, document contents or other secrets.
- Do not expose the management UI directly to the public internet.
- Treat document text and metadata as sensitive data. Logs and diagnostics must avoid unnecessary document content.
- Preserve queue, provenance and OCR-backup behavior when changing processing logic.
- Important identifiers such as invoice numbers, IBAN/BIC, amounts and reference numbers must be handled conservatively; unreadable content must not be guessed.
- Respect confidence/review thresholds and do not convert uncertain results into automatic success.

## Workflow

- GitHub Issues are the durable active backlog; README and operational documentation describe durable behavior.
- Keep changes focused and update documentation when processing, security, deployment, queue/state or operator behavior changes.
- Validate changed JavaScript/Node files and the Docker configuration relevant to the change before completion.
- Release workflow changes require explicit review because they publish the container image.

If central coordination is unavailable, inspect repository Issues/PRs for overlap and record that cross-agent coordination could not be verified.
