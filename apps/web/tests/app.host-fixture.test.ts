import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AppGrant } from '@wilson/sdk';
import { answerAppRequest, APP_METHOD_NAMES, MAX_APP_REQUESTS_IN_FLIGHT, type AppBrokerClient } from '#src/lib/app.broker.js';
import { APP_CONNECT_MESSAGE, APP_CONTENT_SECURITY_POLICY, APP_SANDBOX, appDocument, type AppColorScheme } from '#src/lib/apps.js';

/**
 * The desktop app hosts operator apps too and reads this same file (`AppHostFixtureTests`), so a change
 * to the document or the broker's table here fails until the C# agrees. Regenerate it by hand when the
 * change is meant.
 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/app-host.json', import.meta.url), 'utf8')) as {
    contentSecurityPolicy: string;
    sandbox: string;
    connectMessage: string;
    maxRequestsInFlight: number;
    methods: { name: string; grant?: AppGrant }[];
    html: string;
    context: { project: string; grants: AppGrant[]; colorScheme: AppColorScheme };
    document: string;
};

describe('what the web and desktop hosts share', () => {
    it('is the same document', () => {
        expect(appDocument(fixture.html, fixture.context)).toBe(fixture.document);
    });

    it('is the same policy, sandbox and connect message', () => {
        expect(APP_CONTENT_SECURITY_POLICY).toBe(fixture.contentSecurityPolicy);
        expect(APP_SANDBOX).toBe(fixture.sandbox);
        expect(APP_CONNECT_MESSAGE).toBe(fixture.connectMessage);
    });

    it('is the same limit on waiting requests', () => {
        expect(MAX_APP_REQUESTS_IN_FLIGHT).toBe(fixture.maxRequestsInFlight);
    });

    it('is the same methods, in the same order', () => {
        expect(APP_METHOD_NAMES).toEqual(fixture.methods.map(method => method.name));
    });

    it.each(fixture.methods.filter(method => method.grant))('$name needs $grant', async ({ name, grant }) => {
        const response = await answerAppRequest({ id: 1, method: name, args: [] }, [], {} as AppBrokerClient);

        expect(response).toEqual({ id: 1, ok: false, error: `${name} needs the ${grant} grant, which this app was not installed with` });
    });
});
