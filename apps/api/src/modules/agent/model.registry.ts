import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
import { Injectable } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { optionalConfigString } from '#shared/require.config.js';

export const PROVIDERS = ['anthropic', 'openai', 'xai'] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * Resolves a stage's `provider` + `model` to a language model.
 *
 * Model is a property of the stage, not a per-task choice (PROJECT.md, per-stage model routing).
 * Supporting all three providers now costs one factory each and means re-routing a column to a
 * different vendor stays a config edit rather than a code change.
 *
 * Credentials are per-deployment. A provider with no key configured fails here, by name, rather than
 * as a 401 from inside a running stage.
 */
@Injectable()
export class ModelRegistry {
    constructor(private readonly config: AppConfig) {}

    resolve(provider: Provider, model: string): LanguageModel {
        switch (provider) {
            case 'anthropic':
                return createAnthropic({ apiKey: this.key('ANTHROPIC_API_KEY', provider) })(model);
            case 'openai':
                return createOpenAI({ apiKey: this.key('OPENAI_API_KEY', provider) })(model);
            case 'xai':
                return createXai({ apiKey: this.key('XAI_API_KEY', provider) })(model);
        }
    }

    private key(name: string, provider: Provider): string {
        const value = optionalConfigString(this.config, name);
        if (!value) {
            throw new Error(`Stage is routed to ${provider} but ${name} is not set. Add it to apps/api/.env, or route the stage elsewhere.`);
        }
        return value;
    }
}
