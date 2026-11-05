// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppGrant } from '@wilson/sdk';
import { APP_CHANGE_SETTLE_MS, AppFrame } from '#src/components/AppFrame.js';
import { APP_CONNECT_MESSAGE, APP_CONTENT_SECURITY_POLICY, appDocument } from '#src/lib/apps.js';
import { CardActivityContext } from '#src/lib/feed.js';
import { wilson } from '#src/lib/sdk.js';
import { WilsonSdkProvider } from '#src/lib/sdk-context.js';

/**
 * `AppFrame` and the document it runs. jsdom enforces neither `sandbox` nor CSP, so these pin what the
 * page asks the browser for. That the browser does it has to be checked in a real one.
 */

const openCard = vi.fn();

const frameTree = (changes: number, grants: AppGrant[], html: string) =>
    createElement(
        MantineProvider,
        null,
        createElement(CardActivityContext.Provider, {
            value: { activity: {}, toolLog: {}, now: new Date(0), changes },
            children: createElement(WilsonSdkProvider, {
                client: wilson,
                children: createElement(AppFrame, { name: 'Burndown', html, project: 'demo', grants, openCard }),
            }),
        }),
    );

const renderFrame = (html = '<h1>hello</h1>') => render(frameTree(0, ['board.read'], html));

const CONTEXT = { project: 'demo', grants: [], colorScheme: 'light' as const };

const frame = () => screen.getByTitle('Burndown') as HTMLIFrameElement;

beforeEach(() => {
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('appDocument', () => {
    it('puts the policy before any of the app', () => {
        const doc = appDocument('<script>evil()</script>', CONTEXT);

        expect(doc.indexOf('Content-Security-Policy')).toBeGreaterThan(-1);
        expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<script>'));
    });

    it('puts the client after the policy and before the app', () => {
        const doc = appDocument('<h1>app</h1>', CONTEXT);

        expect(doc.indexOf('window.wilson')).toBeGreaterThan(doc.indexOf('Content-Security-Policy'));
        expect(doc.indexOf('window.wilson')).toBeLessThan(doc.indexOf('<h1>app</h1>'));
    });

    it('cannot be broken out of by what it is told about', () => {
        const doc = appDocument('', { ...CONTEXT, project: '</script><img src=x>' });

        expect(doc).not.toContain('</script><img');
    });

    it('keeps the HTML as installed', () => {
        const html = '<!doctype html><html lang="en"><head><title>x</title></head><body>"quoted"</body></html>';

        expect(appDocument(html, CONTEXT).endsWith(html)).toBe(true);
    });
});

describe('the policy', () => {
    const directives = new Map(
        APP_CONTENT_SECURITY_POLICY.split('; ').map(directive => [directive.split(' ')[0]!, directive.split(' ').slice(1).join(' ')]),
    );

    it('refuses by default, which is what covers fetch and WebSockets', () => {
        expect(directives.get('default-src')).toBe("'none'");
        expect(directives.has('connect-src')).toBe(false);
    });

    it('allows script only inline, without eval', () => {
        expect(directives.get('script-src')).toBe("'unsafe-inline'");
    });

    it('allows nothing from a host or scheme that could carry data out', () => {
        expect(APP_CONTENT_SECURITY_POLICY).not.toMatch(/https?:|blob:|\*|'self'/);
    });

    it('holds no double quote, which would end the attribute it is written into', () => {
        expect(APP_CONTENT_SECURITY_POLICY).not.toContain('"');
    });
});

describe('AppFrame', () => {
    it('runs the app sandboxed, with scripts allowed and nothing else', () => {
        renderFrame();

        expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame().getAttribute('srcdoc')).toBe(appDocument('<h1>hello</h1>', { project: 'demo', grants: ['board.read'], colorScheme: 'light' }));
        expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer');
    });

    it('hands the frame its port once, on the first load', () => {
        renderFrame();
        const post = vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(() => {});

        fireEvent.load(frame());

        expect(post).toHaveBeenCalledTimes(1);
        const [message, origin, transfer] = post.mock.calls[0] as unknown as [string, string, MessagePort[]];
        expect(message).toBe(APP_CONNECT_MESSAGE);
        expect(origin).toBe('*');
        expect(transfer).toHaveLength(1);
    });

    it('hands nothing to whatever loads second, and closes the port', () => {
        const close = vi.spyOn(MessagePort.prototype, 'close');
        renderFrame();
        const post = vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(() => {});
        fireEvent.load(frame());
        post.mockClear();

        fireEvent.load(frame());

        expect(post).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalled();
    });

    it('keeps the frame through its first load', () => {
        renderFrame();

        fireEvent.load(frame());

        expect(frame()).toBeTruthy();
    });

    it('takes the frame away on a second load, and offers to start again', () => {
        renderFrame();
        fireEvent.load(frame());

        fireEvent.load(frame());

        expect(screen.queryByTitle('Burndown')).toBeNull();
        expect(screen.getByText('Burndown tried to leave its page')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Open it again' }));
        fireEvent.load(frame());

        expect(frame()).toBeTruthy();
    });
});

describe('what an app is told', () => {
    /**
     * Collect what reaches the app's end of its port, once jsdom has loaded the frame. It fires that
     * load itself, a moment after rendering, so firing another here would read as the app navigating.
     */
    const connect = async () => {
        const post = vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(() => {});
        await waitFor(() => expect(post).toHaveBeenCalled());
        const [, , transfer] = post.mock.calls[0] as unknown as [string, string, MessagePort[]];
        const events: unknown[] = [];
        transfer[0]!.onmessage = ({ data }) => events.push(data);
        // The colour scheme arrives on connecting, which is what shows the port is live.
        await waitFor(() => expect(events).toContainEqual({ event: 'colorScheme', colorScheme: 'light' }));
        return events;
    };

    const settle = () => new Promise(resolve => setTimeout(resolve, APP_CHANGE_SETTLE_MS + 100));

    it('gives the document the colour scheme, and the same on connecting', async () => {
        renderFrame();

        expect(frame().getAttribute('srcdoc')).toContain('let colorScheme = "light"');

        await connect();
    });

    it('tells an app with a grant that the board changed, carrying nothing else', async () => {
        const { rerender } = render(frameTree(0, ['board.read'], ''));
        const events = await connect();

        rerender(frameTree(1, ['board.read'], ''));

        await waitFor(() => expect(events).toContainEqual({ event: 'change' }));
    });

    it('tells an app with no grants nothing about the board', async () => {
        const { rerender } = render(frameTree(0, [], ''));
        const events = await connect();

        rerender(frameTree(1, [], ''));
        await settle();

        expect(events).not.toContainEqual({ event: 'change' });
    });

    it('turns a burst of changes into one', async () => {
        const { rerender } = render(frameTree(0, ['board.read'], ''));
        const events = await connect();

        for (const changes of [1, 2, 3, 4]) rerender(frameTree(changes, ['board.read'], ''));
        await settle();

        expect(events.filter(event => (event as { event: string }).event === 'change')).toHaveLength(1);
    });

    it('does not reload the frame when told of a change', async () => {
        const { rerender } = render(frameTree(0, ['board.read'], ''));
        const first = frame().getAttribute('srcdoc');

        rerender(frameTree(1, ['board.read'], ''));

        expect(frame().getAttribute('srcdoc')).toBe(first);
    });
});
