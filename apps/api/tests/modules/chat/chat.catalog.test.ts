import { describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from '@maroonedsoftware/logger';
import { PolicyService } from '@maroonedsoftware/policies';
import { ProjectDirectoriesService } from '#modules/board/project.directories.service.js';
import { explainError } from '#modules/chat/chat.catalog.js';
import { ListDirectoriesMcpTool } from '#modules/mcp/generated/projects.mcp.js';
import { fakeCatalog, fakeContainer, fakeHandler, fakeSession, refusal, type FakeCall } from './chat.fakes.js';

/**
 * `ChatCatalog` is how the chat reaches the operation catalog. What matters is that running an
 * operation behaves like the HTTP request it mirrors: in the project it names, refused for a
 * project that is not registered, and with the operation's own refusal surfacing as its sentence.
 */
describe('ChatCatalog', () => {
    const logger = new ConsoleLogger();

    it('describes each operation with its read-only flag', () => {
        const catalog = fakeCatalog([fakeHandler('list_cards', true, []), fakeHandler('move_card', false, [])]);

        expect(catalog.get('list_cards')).toMatchObject({ name: 'list_cards', readOnly: true });
        expect(catalog.get('move_card')).toMatchObject({ name: 'move_card', readOnly: false });
        expect(catalog.get('nothing_like_it')).toBeUndefined();
    });

    it('ranks a match on the name above one on the description, and narrows by read-only', () => {
        const catalog = fakeCatalog([fakeHandler('list_cards', true, []), fakeHandler('move_card', false, []), fakeHandler('get_health', true, [])]);

        expect(catalog.search('card', 10).map(entry => entry.name)).toEqual(['list_cards', 'move_card']);
        expect(catalog.search('card', 10, false).map(entry => entry.name)).toEqual(['move_card']);
        expect(catalog.search('', 2).map(entry => entry.name)).toEqual(['list_cards', 'move_card']);
        expect(catalog.search('zebra', 10)).toEqual([]);
    });

    it('runs an operation inside the project it names', async () => {
        const calls: FakeCall[] = [];
        const catalog = fakeCatalog([fakeHandler('list_cards', true, calls, { result: [{ id: '0007' }] })]);

        const result = await catalog.run(fakeContainer(), logger, fakeSession, 'list_cards', { stage: 'review' }, 'other');

        expect(result).toEqual([{ id: '0007' }]);
        expect(calls).toEqual([{ name: 'list_cards', args: { stage: 'review' }, project: 'other' }]);
    });

    it("runs an operation that names no project in the daemon's own, as a request with no header does", async () => {
        const calls: FakeCall[] = [];
        const catalog = fakeCatalog([fakeHandler('list_projects', true, calls, { result: [] })]);

        await catalog.run(fakeContainer(), logger, fakeSession, 'list_projects', {});

        expect(calls[0]?.project).toBe('default-project');
    });

    it('refuses a project that is not registered, without running anything', async () => {
        const calls: FakeCall[] = [];
        const catalog = fakeCatalog([fakeHandler('list_cards', true, calls)]);

        const failure = await catalog.run(fakeContainer(), logger, fakeSession, 'list_cards', {}, 'nowhere').catch(err => err);

        expect(explainError(failure)).toBe('project "nowhere" is not registered');
        expect(calls).toEqual([]);
    });

    it('refuses an operation that does not exist', async () => {
        const failure = await fakeCatalog([])
            .run(fakeContainer(), logger, fakeSession, 'drop_everything', {})
            .catch(err => err);

        expect(explainError(failure)).toBe('there is no operation named "drop_everything"');
    });

    it('runs a generated handler as the session it was given, which is what its policy judges', async () => {
        const assert = vi.fn(async () => undefined);
        const list = vi.fn(async () => ({ path: '/home/op', parent: undefined, directories: [] }));
        const container = fakeContainer();
        container.override(PolicyService, { assert } as unknown as PolicyService);
        container.override(ProjectDirectoriesService, { list } as unknown as ProjectDirectoriesService);
        const catalog = fakeCatalog([new ListDirectoriesMcpTool()]);

        const result = await catalog.run(container, logger, fakeSession, 'list_directories', {});

        expect(result).toMatchObject({ path: '/home/op' });
        expect(assert).toHaveBeenCalledWith('wilson.view', { session: fakeSession });
    });

    it("passes an operation's own refusal through, to be explained in its own words", async () => {
        const catalog = fakeCatalog([fakeHandler('get_card', true, [], { fails: refusal('card 0099 not found') })]);

        const failure = await catalog.run(fakeContainer(), logger, fakeSession, 'get_card', { id: '0099' }, 'wilson').catch(err => err);

        expect(explainError(failure)).toBe('card 0099 not found');
    });
});
