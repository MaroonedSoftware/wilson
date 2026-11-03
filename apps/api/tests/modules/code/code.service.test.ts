import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerKitContext } from '@maroonedsoftware/koa';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { explainError } from '#modules/chat/chat.catalog.js';
import type { CodeReadRepository, NewCodeRead } from '#modules/code/code.read.repository.js';
import { CodeService } from '#modules/code/code.service.js';
import { fakeSession } from '../chat/chat.fakes.js';

/**
 * What the service adds to the reader: every read and every refusal leaves exactly one record, and a
 * read that cannot be recorded returns no code.
 */
describe('CodeService', () => {
    let root: string;
    let head: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'code-service-'));
        const git = (...args: string[]) =>
            execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }).trim();
        git('init', '-q');
        writeFileSync(join(root, 'README.md'), 'secret sauce\n');
        git('add', '.');
        git('commit', '-qm', 'first');
        head = git('rev-parse', 'HEAD');
    });
    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const serviceWith = (record: (read: NewCodeRead) => Promise<void>) =>
        new CodeService(
            { authenticationSession: fakeSession } as unknown as ServerKitContext,
            new StaticBoardConfig('demo', root, '/tmp/wt', '/tmp/run'),
            { record } as unknown as CodeReadRepository,
        );

    const recording = () => {
        const records: NewCodeRead[] = [];
        return {
            records,
            service: serviceWith(async read => {
                records.push(read);
            }),
        };
    };

    const base = { project: 'demo', subject: fakeSession.subject };

    it('records a read, with the commit it resolved to', async () => {
        const { records, service } = recording();

        const page = await service.read({ path: 'README.md' });

        expect(page.commit).toBe(head);
        expect(records).toEqual([
            { ...base, operation: 'read', path: 'README.md', ref: undefined, pattern: undefined, commit: head, outcome: 'read' },
        ]);
    });

    it('records each operation under its own name, with what it was asked', async () => {
        const { records, service } = recording();

        await service.list({});
        await service.search({ pattern: 'sauce', ref: undefined });

        expect(records.map(({ operation, pattern, outcome }) => ({ operation, pattern, outcome }))).toEqual([
            { operation: 'list', pattern: undefined, outcome: 'read' },
            { operation: 'search', pattern: 'sauce', outcome: 'read' },
        ]);
    });

    it('turns a refusal into a 400 naming the reason, and records it', async () => {
        const { records, service } = recording();

        const failure = await service.read({ path: '.env' }).catch(err => err);

        expect(failure.statusCode).toBe(400);
        expect(explainError(failure)).toContain('deny list');
        expect(records).toEqual([
            expect.objectContaining({ ...base, operation: 'read', path: '.env', outcome: 'refused', reason: expect.stringContaining('deny list') }),
        ]);
    });

    it('records the commit of a refusal that got far enough to resolve one', async () => {
        const { records, service } = recording();

        await service.read({ path: 'nope.txt' }).catch(() => undefined);

        expect(records[0]).toMatchObject({ commit: head, outcome: 'refused' });
    });

    it('records a ref refused before anything ran, as it was asked', async () => {
        const { records, service } = recording();

        await service.read({ path: 'README.md', ref: '-Otouch pwned' }).catch(() => undefined);

        expect(records[0]).toMatchObject({ ref: '-Otouch pwned', commit: undefined, outcome: 'refused' });
    });

    it('returns no content when the read cannot be recorded', async () => {
        const service = serviceWith(() => Promise.reject(new Error('the audit table is gone')));

        const failure = await service.read({ path: 'README.md' }).then(
            page => page,
            (err: Error) => err,
        );

        expect(failure).toBeInstanceOf(Error);
        expect(JSON.stringify(failure)).not.toContain('secret sauce');
        expect((failure as Error).message).toBe('the audit table is gone');
    });

    it('fails a refusal that cannot be recorded, rather than answering it unrecorded', async () => {
        const service = serviceWith(() => Promise.reject(new Error('the audit table is gone')));

        await expect(service.read({ path: '.env' })).rejects.toThrow('the audit table is gone');
    });
});
