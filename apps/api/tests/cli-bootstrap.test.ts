/* eslint-disable turbo/no-undeclared-env-vars -- these tests set made-up variables to see which layer wins; nothing here is a build input */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig } from '#src/cli-bootstrap.js';

/** The variables these tests set, removed after each so nothing leaks into another test. */
const set = new Set<string>();
const setEnv = (name: string, value: string) => {
    set.add(name);
    process.env[name] = value;
};
afterEach(() => {
    for (const name of set) delete process.env[name];
    set.clear();
});

const envFile = async (contents: string): Promise<string> => {
    const path = join(await mkdtemp(join(tmpdir(), 'bootstrap-')), '.env');
    await writeFile(path, contents, 'utf8');
    return path;
};

describe('buildConfig', () => {
    it('reads the environment under .env: the file wins where both set a value, as it always has', async () => {
        setEnv('WILSON_BOOTSTRAP_BOTH', 'from-process');
        setEnv('WILSON_BOOTSTRAP_PROCESS_ONLY', 'process');
        const path = await envFile('WILSON_BOOTSTRAP_BOTH=from-file\nWILSON_BOOTSTRAP_FILE_ONLY=file\n');

        const config = await buildConfig({ envFile: path });

        expect(config.get('WILSON_BOOTSTRAP_BOTH', '')).toBe('from-file');
        expect(config.get('WILSON_BOOTSTRAP_FILE_ONLY', '')).toBe('file');
        expect(config.get('WILSON_BOOTSTRAP_PROCESS_ONLY', '')).toBe('process');
        // Written into the environment by the dotenv source; cleared so it reaches no other test.
        set.add('WILSON_BOOTSTRAP_FILE_ONLY');
    });

    it('is configured by the environment alone when there is no .env, as in a container', async () => {
        setEnv('WILSON_BOOTSTRAP_CONTAINER', '/srv/projects/wilson');

        const config = await buildConfig({ envFile: join(tmpdir(), 'no-such-folder', '.env') });

        expect(config.get('WILSON_BOOTSTRAP_CONTAINER', '')).toBe('/srv/projects/wilson');
    });
});
