import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@maroonedsoftware/appconfig';
import type { Identifier, Registry } from 'injectkit';
import { BoardModule } from '#modules/board/board.module.js';
import { InboundCardWriter } from '#modules/sources/inbound.card.writer.js';
import { SourcesModule } from '#modules/sources/sources.module.js';
import { modules } from '#modules/modules.js';

/**
 * Card 0203. `container.setup.test.ts` already proves the app's *whole* dependency graph resolves,
 * `InboundCardWriter` included now that `SourcesModule` is part of `modules.ts` — but that test would
 * pass the same way whether `InboundCardWriter` were registered `asSingleton` or `asTransient`, or
 * listed anywhere at all in the module order. This file pins the two things `SourcesModule` itself
 * gets right, at the grain a change to `sources.module.ts` alone could break: what it registers `
 * InboundCardWriter` as, and where `modules.ts` lists it relative to `Board` (this card's Task 3 and
 * `modules.ts`'s own comment on the ordering).
 *
 * The recording registry is `JobsModule.setup`'s own idiom (`jobs.module.test.ts`): `setup` only
 * *describes* registrations, so reading back what it described needs no container build and no
 * database.
 */
describe('SourcesModule.setup', () => {
    const fakeConfig = (): AppConfig => ({ get: () => 'unused' }) as unknown as AppConfig;

    /** Records what `register(...)` was called with and which lifetime method closed it out. */
    const recordingRegistry = (): { registry: Registry; registrations: Map<unknown, { useClass: unknown; lifetime: string }> } => {
        const registrations = new Map<unknown, { useClass: unknown; lifetime: string }>();
        const registry = {
            register: (id: Identifier<unknown>) => ({
                useClass: (impl: unknown) => {
                    const entry = { useClass: impl, lifetime: 'unset' };
                    registrations.set(id, entry);
                    return {
                        asSingleton: () => {
                            entry.lifetime = 'singleton';
                        },
                        asTransient: () => {
                            entry.lifetime = 'transient';
                        },
                        asScoped: () => {
                            entry.lifetime = 'scoped';
                        },
                    };
                },
                useFactory: () => ({ asSingleton: () => {}, asTransient: () => {}, asScoped: () => {} }),
                useInstance: () => ({ asSingleton: () => {}, asTransient: () => {}, asScoped: () => {} }),
            }),
        } as unknown as Registry;
        return { registry, registrations };
    };

    it('registers InboundCardWriter as a plain useClass registration', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig());

        expect(registrations.get(InboundCardWriter)?.useClass).toBe(InboundCardWriter);
    });

    // `InboundCardWriter` carries no state of its own to protect across calls, but a stray
    // `asSingleton` would still be a wiring drift worth catching by name rather than by a test that
    // happens to notice stale data later — the same reason `JobsModule.setup`'s tests pin `worker`
    // and `policy` on the registration rather than only exercising `JobsModule.start`.
    it('registers it transient, not as a singleton', async () => {
        const { registry, registrations } = recordingRegistry();

        await SourcesModule.setup!(registry, fakeConfig());

        expect(registrations.get(InboundCardWriter)?.lifetime).toBe('transient');
    });

    it('names itself "Sources"', () => {
        expect(SourcesModule.name).toBe('Sources');
    });
});

/**
 * The ordering claim `modules.ts`'s own comment makes for card 0203: Sources is listed right after
 * Board, because `InboundCardWriter` depends on tokens only Board's `setup` registers. A future edit
 * that moves Sources earlier (before Board has registered `BoardWriteService`/`BoardRepository`) would
 * not fail `container.setup.test.ts` — `setup` only *describes* registrations, per that file's own
 * "what this does and does not prove" — so this pins the list order directly instead.
 */
describe('modules.ts ordering', () => {
    it('lists Sources immediately after Board', () => {
        const boardIndex = modules.indexOf(BoardModule);
        const sourcesIndex = modules.indexOf(SourcesModule);

        expect(boardIndex).toBeGreaterThanOrEqual(0);
        expect(sourcesIndex).toBe(boardIndex + 1);
    });
});
