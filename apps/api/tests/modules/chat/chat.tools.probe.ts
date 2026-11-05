import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CliChatEngine } from '#modules/chat/cli.chat.engine.js';
import type { ChatTool } from '#modules/chat/chat.tools.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

/**
 * Runs a real turn on the machine's Claude login with `onlyOwnTools` on, which the mocked tests cannot
 * do: only the engine itself can say what it offers on `init`. A build that started offering a tool
 * despite `tools: []` would fail every chat turn, and this is where that would show first. Reached only
 * through `test:engine`, which an operator runs by hand.
 */
describe('chat tools on the cli engine', () => {
    it('offers and uses nothing but the tools it was given', { timeout: 120_000 }, async () => {
        let called = false;
        const ping: ChatTool = {
            name: 'ping',
            description: 'Answers with a word to repeat.',
            input: z.object({}),
            execute: async () => {
                called = true;
                return 'marmalade';
            },
        };

        const { text } = await new CliChatEngine({ get: async () => undefined } as unknown as SettingsStore).turn({
            thread: { id: 'probe' },
            history: [],
            text: 'Call the ping tool, then repeat the word it answers with.',
            system: 'You answer briefly.',
            tools: [ping],
            provider: 'anthropic',
            model: 'claude-haiku-5-5',
            onlyOwnTools: true,
        });

        expect(called).toBe(true);
        expect(text.toLowerCase()).toContain('marmalade');
    });
});
