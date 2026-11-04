## Goal

Add an operational setting for the engine's config directory, with a contract, a route and a field on the settings page. A saved value wins over the environment variable, and saving it empty clears it. Both places that build the engine's environment read the setting.

## Files in scope

- apps/api/data/contracts/settings.ck
- apps/api/src/generated/settings.ts
- apps/api/src/modules/agent/cli.stage.agent.ts
- apps/api/src/modules/agent/plan.session.agent.ts
- apps/api/src/modules/plan/plan.service.ts
- apps/api/src/modules/settings/claude.config.dir.setting.service.ts
- apps/api/src/modules/settings/claude.config.dir.setting.ts
- apps/api/src/modules/settings/settings.module.ts
- apps/api/src/routes/settings.router.ts
- apps/web/src/routes/settings.tsx
- packages/sdk/src/settings.client.ts
- packages/sdk/src/types/settings.ts
