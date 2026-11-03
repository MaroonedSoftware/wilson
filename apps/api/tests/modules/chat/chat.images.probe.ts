import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CliChatEngine } from '#modules/chat/cli.chat.engine.js';
import type { ChatImage, ChatTurnInput } from '#modules/chat/chat.engine.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

/**
 * Sends real images through the 'cli' engine on the machine's Claude login, which the mocked tests
 * cannot do: they prove the call this engine makes, not that the engine accepts it. Reached only
 * through `test:engine`, which an operator runs by hand.
 */
const crc = (bytes: Buffer): number => {
    let value = ~0;
    for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    return ~value >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
    const tagged = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(tagged));
    return Buffer.concat([length, tagged, check]);
};

/** A real PNG of `side` square, filled by `pixel`: a colour to name, or noise to reach a size. */
const png = (side: number, pixels: (rowBytes: number) => Buffer): ChatImage => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(side, 0);
    header.writeUInt32BE(side, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const rows = Buffer.concat(Array.from({ length: side }, () => Buffer.concat([Buffer.from([0]), pixels(side * 3)])));
    return {
        contentType: 'image/png',
        bytes: Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk('IHDR', header),
            chunk('IDAT', deflateSync(rows, { level: 0 })),
            chunk('IEND', Buffer.alloc(0)),
        ]),
    };
};

const solidRed = () => png(64, rowBytes => Buffer.alloc(rowBytes).map((_, index) => (index % 3 === 0 ? 255 : 0)) as Buffer);
const noiseOf = (megabytes: number) => png(Math.ceil(Math.sqrt((megabytes * 1024 * 1024) / 3)), rowBytes => randomBytes(rowBytes));

const engine = new CliChatEngine({ get: async () => undefined } as unknown as SettingsStore);
const turn = (input: Partial<ChatTurnInput>) =>
    engine.turn({
        thread: { id: 'probe' },
        history: [],
        text: 'Answer in one word.',
        system: 'You answer briefly.',
        tools: [],
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        ...input,
    });

describe('chat images on the cli engine', () => {
    it('sees an image', { timeout: 120_000 }, async () => {
        const { text } = await turn({ text: 'What colour is this image? Answer in one word.', images: [solidRed()] });
        expect(text.toLowerCase()).toContain('red');
    });

    it('sees an image with no text', { timeout: 120_000 }, async () => {
        const { text } = await turn({ text: '', images: [solidRed()] });
        expect(text.length).toBeGreaterThan(0);
    });

    it('keeps seeing it when the session resumes', { timeout: 180_000 }, async () => {
        const first = await turn({ text: 'Remember this image. Say ok.', images: [solidRed()] });
        const { text } = await turn({
            thread: { id: 'probe', engineSessionId: first.engineSessionId },
            text: 'What colour was that image? One word.',
        });
        expect(text.toLowerCase()).toContain('red');
    });

    for (const megabytes of [3.7, 4.5]) {
        it(`reports what happens at ${megabytes} MB`, { timeout: 180_000 }, async () => {
            const image = noiseOf(megabytes);
            const outcome = await turn({ text: 'Say ok.', images: [image] }).then(
                ({ text }) => `answered: ${text}`,
                (err: Error) => `failed: ${err.message}`,
            );
            console.log(
                `${(image.bytes.length / 1024 / 1024).toFixed(2)} MB, ${((image.bytes.length * 4) / 3 / 1024 / 1024).toFixed(2)} MB as base64: ${outcome}`,
            );
        });
    }
});
