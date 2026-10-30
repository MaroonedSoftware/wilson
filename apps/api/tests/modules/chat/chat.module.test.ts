import { describe, expect, it } from 'vitest';
import type { Container } from 'injectkit';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { ServerKitContext, ServerKitServerBuilder } from '@maroonedsoftware/koa';
import { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { BoardConfig } from '#modules/board/board.config.js';
import { ChatService } from '#modules/chat/chat.service.js';
import { modules } from '#src/cli-bootstrap.js';
import { buildTestServerConfig } from '#tests/support/test.config.js';
import { fakeSession } from './chat.fakes.js';

/**
 * `ChatService` is resolved from a request's scope, which `serverKitContextMiddleware` disposes when
 * the response closes, but a follow-up runs after that, and a turn can outlast a client that hangs
 * up. This builds the app's own container, as `container.setup.test.ts` does, and resolves the
 * service the way a route does, because the lifetimes in question exist only in the real wiring.
 */
describe('ChatModule', () => {
    /** The private parts of the service that a turn reaches after its request has gone. */
    type TurnWiring = { container: Container; choose: () => Promise<unknown>; session: () => unknown };

    const withRequestScope = async (run: (service: TurnWiring, closeRequest: () => Promise<void>) => Promise<void>) => {
        const container = await new ServerKitServerBuilder().setup(await buildTestServerConfig(), new ConsoleLogger(), modules);
        try {
            const scope = container.createScopedContainer();
            scope.override(ServerKitContext, { authenticationSession: fakeSession } as unknown as ServerKitContext);
            await run(scope.get(ChatService) as unknown as TurnWiring, () => scope.disposeAsync());
        } finally {
            await container.get(Kysely<DB>).destroy();
        }
    };

    it('reads the session from the request it was resolved in', async () => {
        await withRequestScope(async service => {
            expect(service.session()).toBe(fakeSession);
        });
    });

    it('can still run operations and choose an engine once the request has closed', async () => {
        await withRequestScope(async (service, closeRequest) => {
            await closeRequest();

            expect(service.container.createScopedContainer().get(BoardConfig)).toBeDefined();
            await expect(service.choose()).resolves.toBeDefined();
        });
    });
});
