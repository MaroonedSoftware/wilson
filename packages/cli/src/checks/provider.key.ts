import type { Check } from '@maroonedsoftware/johnny5';
import { setting } from '../settings.js';

/**
 * At least one provider key must be present.
 *
 * Not "the right one for every stage" — that is checked when a stage resolves its model, by name.
 * This catches the cold-clone case where none is set at all.
 */
export const providerKeySet: Check = {
    name: 'model provider key set',
    run: async ctx => {
        const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY'];
        const present = keys.filter(key => setting(ctx, key, ''));
        if (present.length === 0) {
            return {
                ok: false,
                message: 'no provider key configured',
                fixHint: 'Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / XAI_API_KEY) in apps/api/.env.',
            };
        }
        return { ok: true, message: present.join(', ') };
    },
};
