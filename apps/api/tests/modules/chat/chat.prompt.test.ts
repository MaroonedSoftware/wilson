import { describe, expect, it } from 'vitest';
import { chatSystemPrompt } from '#modules/chat/chat.prompt.js';
import { chatTools } from '#modules/chat/chat.tools.js';
import { fakeCatalog, fakeContainer, turnContext } from './chat.fakes.js';

describe('the chat system prompt', () => {
    it('never names a tool, since the cli engine serves them under qualified names', () => {
        const prompt = chatSystemPrompt({ projects: ['wilson'], currentProject: 'wilson' });

        for (const tool of chatTools(fakeCatalog([]), turnContext(fakeContainer()))) {
            expect(prompt, tool.name).not.toContain(tool.name);
        }
    });

    it('names the registered projects and the one the person is looking at', () => {
        const prompt = chatSystemPrompt({ projects: ['wilson', 'ats'], currentProject: 'ats' });

        expect(prompt).toContain('Registered projects: wilson, ats.');
        expect(prompt).toContain('looking at the "ats" project');
    });

    it('asks which project is meant when the person is on no project page', () => {
        expect(chatSystemPrompt({ projects: [] })).toContain('ask which they mean');
    });
});
