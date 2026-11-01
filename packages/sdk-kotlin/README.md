# sdk-kotlin

The Wilson API as Kotlin: `@Serializable` models and a Ktor client, generated from the same `.ck`
contracts as `packages/sdk`. `apps/android` compiles it as its `:sdk` subproject.

**Everything under `src/` is generated. Never hand-edit it.** Run `pnpm codegen`. Kotlin that does not
compile is fixed in ContractKit, not here. `build.gradle.kts` is the one hand-written file.

This is not a pnpm workspace member: with no `package.json`, the `packages/*` glob skips it.

The event streams (`/api/feed`, the plan and chat streams) are not in the contracts, so they are not
here either.
