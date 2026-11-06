import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StageAgentMap, type AgentRunInput, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { CardAttachmentRepository } from '#modules/context/card.attachment.repository.js';
import type { HostPlacer } from '#modules/host/host.placer.js';
import type { RemotePlacement } from '#modules/host/placement.js';
import { SshGitTransport } from '#modules/host/ssh.git.transport.js';
import type { ScopeDecision } from '#modules/agent/scope.guard.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { DB } from '#modules/data/db.js';
import { MemoryHost } from '#tests/support/memory.host.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * Card 0010: `StageDispatcher.run` writes each of the card's attached images to
 * `<runRoot>/cards/<id>/attachments/<attachmentId>-<filename>` — beside `plan.md`, outside the
 * worktree — grants each one as a readable extra, and hands the set to the adapter. The directory is
 * deleted and rewritten on every dispatch, so it is always exactly the card's current attachments. A
 * placed stage gets the same files under the host's run root, and none here.
 */
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const STAGES = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    placement: any
    onPass: merged
    onFail: testing
`;

const cardFor = (id: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'testing', dependsOn: [], retries: {} },
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
});

/** Bytes that are not valid UTF-8, so a text write would mangle them. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xc3, 0x28]);

const placementOn = (host: MemoryHost): RemotePlacement => ({
    hostName: 'agent-3',
    host,
    git: new SshGitTransport('agent-3', 'ssh'),
    codeRoot: '/opt/agent/TGA',
    worktreeRoot: '/opt/agent/wt',
    runRoot: '/opt/agent/run',
    slotKey: 'host:agent-3:slot:1',
});

interface Probe {
    input: AgentRunInput;
    reads: Record<string, ScopeDecision>;
    writes: Record<string, ScopeDecision>;
}

const setUp = async (options: { withRepository?: boolean; placement?: RemotePlacement } = {}) => {
    const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-attachments-'));
    const worktreeDir = join(base, 'worktree');
    await mkdir(worktreeDir, { recursive: true });

    const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
    const events = { append: vi.fn(async () => {}) };
    const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    await board.create(cardFor('0001'), 'initial');
    const repository = new CardAttachmentRepository(config, db);

    const worktrees = {
        resolveBranch: vi.fn(() => 'card/0001-x'),
        hasWork: vi.fn(async () => false),
        create: vi.fn(async (_cardId: string, branch: string, _at: string | undefined, placement?: RemotePlacement) => ({
            path: placement ? '/remote/wt/0001' : worktreeDir,
            branch,
            baseSha: 'deadbeef',
            ...(placement && { host: placement.host, placement }),
        })),
        commit: vi.fn(async () => 'committedsha'),
        uncommittedPaths: vi.fn(async () => []),
        uncommittedSnapshot: vi.fn(async () => ({})),
        fetchBack: vi.fn(async () => {}),
        reclaim: vi.fn(async () => {}),
        failedAttemptPatchPath: (cardId: string) => join(config.runRoot, 'cards', cardId, 'last-failed-attempt.patch'),
    };

    const probes: Probe[] = [];
    const agents = new StageAgentMap();
    agents.set('api', {
        run: async (input: AgentRunInput): Promise<AgentRunOutput> => {
            const reads: Record<string, ScopeDecision> = {};
            const writes: Record<string, ScopeDecision> = {};
            for (const attachment of input.attachments ?? []) {
                reads[attachment.path] = await input.context.scope.checkRead(attachment.path);
                writes[attachment.path] = await input.context.scope.check(attachment.path);
            }
            probes.push({ input, reads, writes });
            return { result: { summary: 'did it', caveats: [] }, usage: { inputTokens: 1 }, truncated: false };
        },
    });
    const verifiers = new StageVerifierMap();
    verifiers.set('testing', { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) });
    const resultSchemas = new StageResultSchemaMap();
    resultSchemas.set('testing', {} as never);

    const placer = options.placement
        ? {
              place: vi.fn(async () => options.placement),
              isAlive: vi.fn(async () => true),
              markLost: vi.fn(async () => {}),
              takeLocalSlot: vi.fn(async () => ({ key: 'local:slot:1' })),
              releaseSlot: vi.fn(async () => {}),
          }
        : undefined;

    const dispatcher = new StageDispatcher(
        config,
        new StaticStageConfigStore(STAGES),
        board,
        worktrees as unknown as WorktreeManager,
        agents,
        verifiers,
        resultSchemas,
        events as unknown as EventLog,
        silentLogger as never,
        undefined,
        undefined,
        undefined,
        placer as unknown as HostPlacer | undefined,
        undefined,
        undefined,
        undefined,
        options.withRepository === false ? undefined : repository,
    );

    const attach = (filename: string, contentType: string, bytes: Buffer) =>
        repository.insert('0001', {
            filename,
            contentType,
            bytes,
            contentHash: createHash('sha256').update(bytes).digest('hex'),
            addedBy: 'tester',
        });

    // Every dispatch moves the card on; put it back so the same stage can run again.
    const resetStage = () =>
        board.write('0001', 'back to testing', current => ({ ...current, frontmatter: { ...current.frontmatter, stage: 'testing' } }));

    const localDir = join(config.runRoot, 'cards', '0001', 'attachments');
    return { dispatcher, repository, events, probes, attach, resetStage, localDir, worktreeDir };
};

describe('StageDispatcher.run materialises a card’s attachments (card 0010)', () => {
    it('AC1/AC2: writes each attachment byte for byte beside the plan, and hands the adapter path, filename, type and bytes', async () => {
        const { dispatcher, probes, attach, localDir } = await setUp();
        const png = await attach('login.png', 'image/png', PNG);
        const jpeg = await attach('mockup.jpg', 'image/jpeg', JPEG);

        const outcome = await dispatcher.run('0001', 'testing');

        expect(outcome.passed).toBe(true);
        const pngPath = join(localDir, `${png.id}-login.png`);
        const jpegPath = join(localDir, `${jpeg.id}-mockup.jpg`);
        expect((await readdir(localDir)).sort()).toEqual([`${png.id}-login.png`, `${jpeg.id}-mockup.jpg`].sort());
        expect(Buffer.compare(await readFile(pngPath), PNG)).toBe(0);
        expect(Buffer.compare(await readFile(jpegPath), JPEG)).toBe(0);

        const attachments = probes[0]!.input.attachments!;
        expect(attachments).toHaveLength(2);
        expect(attachments[0]).toMatchObject({ path: pngPath, filename: 'login.png', contentType: 'image/png' });
        expect(Buffer.compare(attachments[0]!.bytes, PNG)).toBe(0);
        expect(attachments[1]).toMatchObject({ path: jpegPath, filename: 'mockup.jpg', contentType: 'image/jpeg' });
        expect(Buffer.compare(attachments[1]!.bytes, JPEG)).toBe(0);
    });

    it('AC3: each path is readable through the scope guard and never writable', async () => {
        const { dispatcher, probes, attach, localDir } = await setUp();
        const png = await attach('login.png', 'image/png', PNG);

        await dispatcher.run('0001', 'testing');

        const path = join(localDir, `${png.id}-login.png`);
        expect(probes[0]!.reads[path]).toMatchObject({ allowed: true, path });
        expect(probes[0]!.writes[path]).toMatchObject({ allowed: false });
    });

    it('AC4: a second dispatch after a deletion leaves exactly the remaining file', async () => {
        const { dispatcher, repository, probes, attach, resetStage, localDir } = await setUp();
        const png = await attach('login.png', 'image/png', PNG);
        const jpeg = await attach('mockup.jpg', 'image/jpeg', JPEG);

        await dispatcher.run('0001', 'testing');
        await repository.remove('0001', png.id);
        await resetStage();
        await dispatcher.run('0001', 'testing');

        expect(await readdir(localDir)).toEqual([`${jpeg.id}-mockup.jpg`]);
        expect(probes[1]!.input.attachments!.map(a => a.filename)).toEqual(['mockup.jpg']);
    });

    it('AC4: a second dispatch with no change leaves the same files, none duplicated or renamed', async () => {
        const { dispatcher, attach, resetStage, localDir } = await setUp();
        await attach('login.png', 'image/png', PNG);
        await attach('mockup.jpg', 'image/jpeg', JPEG);

        await dispatcher.run('0001', 'testing');
        const first = (await readdir(localDir)).sort();
        await resetStage();
        await dispatcher.run('0001', 'testing');

        expect((await readdir(localDir)).sort()).toEqual(first);
        expect(first).toHaveLength(2);
    });

    it('AC4: removing the last attachment between dispatches leaves no directory and hands the adapter none', async () => {
        const { dispatcher, repository, probes, attach, resetStage, localDir } = await setUp();
        const png = await attach('login.png', 'image/png', PNG);

        await dispatcher.run('0001', 'testing');
        expect(await readdir(localDir)).toEqual([`${png.id}-login.png`]);
        await repository.remove('0001', png.id);
        await resetStage();
        await dispatcher.run('0001', 'testing');

        expect(existsSync(localDir)).toBe(false);
        expect(probes[1]!.input.attachments ?? []).toEqual([]);
    });

    it('AC4: two attachments with the same filename land as two distinct files', async () => {
        const { dispatcher, probes, attach, localDir } = await setUp();
        const a = await attach('shot.png', 'image/png', PNG);
        const b = await attach('shot.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));

        await dispatcher.run('0001', 'testing');

        expect((await readdir(localDir)).sort()).toEqual([`${a.id}-shot.png`, `${b.id}-shot.png`].sort());
        expect(new Set(probes[0]!.input.attachments!.map(x => x.path)).size).toBe(2);
    });

    it('AC5: a card with no attachments gets none, and no directory', async () => {
        const { dispatcher, probes, localDir } = await setUp();

        await dispatcher.run('0001', 'testing');

        expect(probes[0]!.input.attachments ?? []).toEqual([]);
        expect(existsSync(localDir)).toBe(false);
    });

    it('AC5: a dispatcher constructed with no repository materialises nothing', async () => {
        const { dispatcher, probes, attach, localDir } = await setUp({ withRepository: false });
        await attach('login.png', 'image/png', PNG);

        const outcome = await dispatcher.run('0001', 'testing');

        expect(outcome.passed).toBe(true);
        expect(probes[0]!.input.attachments ?? []).toEqual([]);
        expect(existsSync(localDir)).toBe(false);
    });

    it('AC7: nothing is written under the worktree', async () => {
        const { dispatcher, probes, attach, worktreeDir } = await setUp();
        await attach('login.png', 'image/png', PNG);

        await dispatcher.run('0001', 'testing');

        expect(await readdir(worktreeDir)).toEqual([]);
        expect(probes[0]!.input.attachments!.every(a => !a.path.startsWith(worktreeDir))).toBe(true);
    });

    it('AC10: the stage.dispatched event carries the attachment count', async () => {
        const { dispatcher, events, attach } = await setUp();
        await attach('login.png', 'image/png', PNG);
        await attach('mockup.jpg', 'image/jpeg', JPEG);

        await dispatcher.run('0001', 'testing');

        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'stage.dispatched', payload: expect.objectContaining({ attachments: 2 }) }),
        );
    });

    describe('a placed stage', () => {
        it('AC6: writes each image to the host byte for byte, names the host path, and writes none here', async () => {
            const host = new MemoryHost();
            const { dispatcher, probes, attach, localDir } = await setUp({ placement: placementOn(host) });
            const png = await attach('login.png', 'image/png', PNG);

            const outcome = await dispatcher.run('0001', 'testing');

            expect(outcome.passed).toBe(true);
            const remote = `/opt/agent/run/cards/0001/attachments/${png.id}-login.png`;
            expect(Buffer.compare(host.bytes.get(remote)!, PNG)).toBe(0);
            expect(host.files.has(remote)).toBe(false);
            expect(probes[0]!.input.attachments!.map(a => a.path)).toEqual([remote]);
            expect(probes[0]!.reads[remote]).toMatchObject({ allowed: true });
            expect(existsSync(localDir)).toBe(false);
        });

        it('AC6: a second dispatch after a deletion leaves only the remaining image on the host', async () => {
            const host = new MemoryHost();
            const { dispatcher, repository, attach, resetStage } = await setUp({ placement: placementOn(host) });
            const png = await attach('login.png', 'image/png', PNG);
            const jpeg = await attach('mockup.jpg', 'image/jpeg', JPEG);

            await dispatcher.run('0001', 'testing');
            await repository.remove('0001', png.id);
            await resetStage();
            await dispatcher.run('0001', 'testing');

            expect([...host.bytes.keys()]).toEqual([`/opt/agent/run/cards/0001/attachments/${jpeg.id}-mockup.jpg`]);
        });

        it('AC3/AC6: the host path is readable and never writable, and the event counts it', async () => {
            const host = new MemoryHost();
            const { dispatcher, events, probes, attach } = await setUp({ placement: placementOn(host) });
            const png = await attach('login.png', 'image/png', PNG);

            await dispatcher.run('0001', 'testing');

            const remote = `/opt/agent/run/cards/0001/attachments/${png.id}-login.png`;
            expect(probes[0]!.reads[remote]).toMatchObject({ allowed: true });
            expect(probes[0]!.writes[remote]).toMatchObject({ allowed: false });
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'stage.dispatched', payload: expect.objectContaining({ attachments: 1 }) }),
            );
        });

        it('AC6: removing the last attachment clears it from the host on the next dispatch', async () => {
            const host = new MemoryHost();
            const { dispatcher, repository, probes, attach, resetStage } = await setUp({ placement: placementOn(host) });
            const png = await attach('login.png', 'image/png', PNG);

            await dispatcher.run('0001', 'testing');
            expect(host.bytes.size).toBe(1);
            await repository.remove('0001', png.id);
            await resetStage();
            await dispatcher.run('0001', 'testing');

            expect([...host.bytes.keys()].filter(k => k.includes('/attachments/'))).toEqual([]);
            expect(probes[1]!.input.attachments ?? []).toEqual([]);
        });
    });
});
