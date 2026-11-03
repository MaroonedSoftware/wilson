import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../../../deploy/prune.images.sh', import.meta.url));
const IMAGE = 'ghcr.io/maroonedsoftware/wilson';

/** Newest first, as `docker images` lists them. `other` stands for another tag the script must not touch. */
const TAGS = ['slim', 'slim-aaa', 'slim-bbb', 'slim-ccc', 'slim-ddd', 'slim-eee', 'other'];

/** Untagged builds: two of this image, one of them in use, and another project's that the script must leave alone. */
const UNTAGGED = ['sha256:old ' + IMAGE, 'sha256:running ' + IMAGE, 'sha256:theirs ghcr.io/someone/else'];

/** A `docker` that answers from `TAGS` and `UNTAGGED`, says `slim-ccc` and `running` are what the containers run (`xargs` puts their ids last), and logs each `rmi`. */
const fakeDocker = `#!/usr/bin/env bash
case "$1" in
    ps) echo c1 ;;
    images)
        case "$*" in
            *dangling=true*) printf '%s\n' ${UNTAGGED.map(line => `'${line}'`).join(' ')} ;;
            *) for tag in ${TAGS.join(' ')}; do echo "${IMAGE}:$tag"; done ;;
        esac
        ;;
    inspect)
        case "$*" in
            *" c1") printf '%s\n' sha256:slim-ccc sha256:running ;;
            *) echo "sha256:\${2##*:}" ;;
        esac
        ;;
    rmi) echo "$2" >> "$RMI_LOG" ;;
    *) echo "unexpected: $*" >> "$RMI_LOG"; exit 1 ;;
esac
`;

describe('deploy/prune.images.sh', () => {
    let dir: string;
    let log: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'prune-images-'));
        log = join(dir, 'rmi.log');
        await writeFile(log, '');
        await writeFile(join(dir, 'docker'), fakeDocker);
        await chmod(join(dir, 'docker'), 0o755);
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const run = (env: Record<string, string> = {}) => exec('bash', [SCRIPT], { env: { PATH: `${dir}:${process.env.PATH}`, RMI_LOG: log, ...env } });
    const removed = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean);
    const removedTags = async () => (await removed()).filter(entry => entry !== 'sha256:old');

    it('keeps what is in use and the newest two, and removes only older slim-<sha> tags', async () => {
        const { stdout } = await run();

        expect(await removedTags()).toEqual([`${IMAGE}:slim-ddd`, `${IMAGE}:slim-eee`]);
        expect(stdout).toContain(`in use: ${IMAGE}:slim-ccc`);
        expect(stdout).toContain(`kept: ${IMAGE}:slim-aaa`);
        expect(stdout).toContain(`kept: ${IMAGE}:slim-bbb`);
    });

    it('removes nothing on a dry run', async () => {
        const { stdout } = await run({ DRY_RUN: '1' });

        expect(await removed()).toEqual([]);
        expect(stdout).toContain(`would remove: ${IMAGE}:slim-eee`);
        expect(stdout).toContain('would remove: sha256:old');
    });

    it('takes how many to keep', async () => {
        await run({ KEEP: '0' });

        expect(await removedTags()).toEqual([`${IMAGE}:slim-aaa`, `${IMAGE}:slim-bbb`, `${IMAGE}:slim-ddd`, `${IMAGE}:slim-eee`]);
    });

    it("removes this image's untagged builds, keeping none as rollbacks, unless a container uses one", async () => {
        const { stdout } = await run({ KEEP: '5' });

        expect(await removed()).toEqual(['sha256:old']);
        expect(stdout).toContain('in use: sha256:running');
    });

    it("leaves another project's untagged image alone", async () => {
        const { stdout } = await run();

        expect(await removed()).not.toContain('sha256:theirs');
        expect(stdout).not.toContain('sha256:theirs');
    });

    it('never runs a prune', async () => {
        expect(await readFile(SCRIPT, 'utf8')).not.toMatch(/^[^#]*docker\s+\S*\s*prune/m);
    });
});
