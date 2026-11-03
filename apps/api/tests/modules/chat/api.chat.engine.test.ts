import { describe, expect, it } from 'vitest';
import { ApiChatEngine } from '#modules/chat/api.chat.engine.js';
import type { ChatTurnInput } from '#modules/chat/chat.engine.js';
import { says, scriptedModel } from './chat.model.fake.js';

const image = { contentType: 'image/png' as const, bytes: Buffer.from([1, 2, 3]) };

const lastUser = (prompts: unknown[]) => {
    const prompt = prompts.at(-1) as { role: string; content: { type: string; text?: string; mediaType?: string }[] }[];
    return prompt.filter(message => message.role === 'user');
};

const turn = async (input: Partial<ChatTurnInput>) => {
    const model = scriptedModel([says('An answer.')]);
    await new ApiChatEngine(model.registry).turn({
        thread: { id: '7' },
        history: [],
        text: 'what is this?',
        system: 'the system prompt',
        tools: [],
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        ...input,
    });
    return lastUser(model.prompts);
};

describe('ApiChatEngine images', () => {
    it('sends text alone when there are no images', async () => {
        const [user] = await turn({});

        expect(user!.content).toEqual([{ type: 'text', text: 'what is this?' }]);
    });

    it('sends images ahead of the text', async () => {
        const [user] = await turn({ images: [image] });

        expect(user!.content.map(part => part.type)).toEqual(['file', 'text']);
        expect(user!.content[0]).toMatchObject({ mediaType: 'image/png' });
    });

    it('leaves out an empty text part when only images were sent', async () => {
        const [user] = await turn({ text: '', images: [image] });

        expect(user!.content.map(part => part.type)).toEqual(['file']);
    });

    it('replays the images it is given, and says where the rest were', async () => {
        const [older, recent] = await turn({
            history: [
                { role: 'user', content: 'an old one', imageCount: 2, engineMessages: undefined },
                { role: 'assistant', content: 'Seen.', engineMessages: undefined },
                { role: 'user', content: 'a new one', imageCount: 1, images: [image], engineMessages: undefined },
                { role: 'assistant', content: 'Seen too.', engineMessages: undefined },
            ],
        });

        expect(older!.content).toEqual([
            { type: 'text', text: '[2 earlier images were attached here.]' },
            { type: 'text', text: 'an old one' },
        ]);
        expect(recent!.content.map(part => part.type)).toEqual(['file', 'text']);
    });
});
