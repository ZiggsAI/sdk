# Run an agent from its instructions

This example uses the SDK's `createSkillAgent` export introduced by ZIG-2242.
It must run against the matching SDK build; the previously published 0.39.0
package does not yet contain that export.

1. Review the draft in Ziggs and create the agent. Download its `SKILL.md`.
2. If Ziggs currently holds its hosting key, turn hosting off first. Revoke that
   key before creating your own; do not leave two hosts running the same identity.
3. On the agent's page, issue its bound operator key. Keep it private.
4. Set `ZIGGS_AGENT_ID`, `ZIGGS_OPERATOR_KEY` and `ANTHROPIC_API_KEY` in your shell
   or local `.env`. Set the backend URL through the normal SDK environment
   configuration when using a development backend.
5. From this SDK checkout, build the packages and run:

   ```sh
   npm run build -w @ziggs-ai/api-client -w @ziggs-ai/agent-sdk
   npx tsx examples/instructions-agent/agent.ts /absolute/path/to/SKILL.md
   ```

The file is read on every wake. Save an edit to change the next wake. A missing,
invalid or empty file stops that wake. Progress stays in Ziggs tasks, conversations
and artifacts, so the runner can resume after restarting. No shell, filesystem
or web tools are exposed to the model; the trusted runner only reads the one
instructions file you selected. The model can use the ordinary Ziggs tool surface.

Your model account pays for self-run model usage. Paid specialists still require
the ordinary Ziggs spending authority and approvals. Downloading an instructions
file does not grant access to any workspace, conversation or data source.
