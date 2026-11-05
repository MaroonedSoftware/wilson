// @vitest-environment jsdom
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { App, AppSummary } from '@wilson/sdk';
import { AppsControl } from '#src/components/AppsControl.js';
import { APP_MANIFEST_TYPE } from '#src/lib/app.manifest.js';
import { addedGrants, MAX_APP_HTML_BYTES } from '#src/lib/apps.js';
import { wilson } from '#src/lib/sdk.js';
import { WilsonSdkProvider } from '#src/lib/sdk-context.js';

/** The settings page's Apps section (`AppsControl`): installing, replacing and removing operator apps. */

const NOW = DateTime.fromISO('2026-11-05T00:00:00.000Z');
const burndown: AppSummary = {
    slug: 'burndown',
    name: 'Burndown',
    description: 'Cards left',
    grants: ['board.read'],
    apiVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
};
const stored: App = { ...burndown, html: '<h1>stored</h1>' };

const renderControl = (project?: string) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        createElement(
            MantineProvider,
            null,
            createElement(
                QueryClientProvider,
                { client },
                createElement(WilsonSdkProvider, { client: wilson, children: createElement(AppsControl, { project }) }),
            ),
        ),
    );
};

/** jsdom's `File` has no `text()`. */
const htmlFile = (name: string, html: string): File => {
    const file = new File([html], name, { type: 'text/html' });
    Object.defineProperty(file, 'text', { value: async () => html });
    return file;
};

const BOARD = { grant: 'board.read', reason: 'Counts the cards.' };
const STATS = { grant: 'stats.read', reason: 'Shows the spend.' };

/** An app's HTML, with a manifest saying what it is. */
const appHtml = (fields: Record<string, unknown> = {}) =>
    `<!doctype html><script type="${APP_MANIFEST_TYPE}">${JSON.stringify({
        id: 'burn-down',
        name: 'Burn down',
        version: '1.0.0',
        apiVersion: 1,
        description: 'Cards left',
        grants: [],
        ...fields,
    })}</script><h1>new</h1>`;

const pick = (container: HTMLElement, file: File) => fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

const listApps = () => vi.spyOn(wilson.apps, 'listApps');
const installApp = () => vi.spyOn(wilson.apps, 'installApp').mockResolvedValue(stored);

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
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('AppsControl', () => {
    it('says so when no apps are installed', async () => {
        listApps().mockResolvedValue([]);

        renderControl();

        expect(await screen.findByText('No apps installed.')).toBeTruthy();
    });

    it('lists an app with what it can read', async () => {
        listApps().mockResolvedValue([burndown]);

        renderControl();

        expect(await screen.findByText('Burndown')).toBeTruthy();
        expect(screen.getByText('Cards left')).toBeTruthy();
        expect(screen.getByText('Board', { selector: '.mantine-Badge-label' })).toBeTruthy();
    });

    it('installs a file as its manifest says, with only the grants ticked', async () => {
        listApps().mockResolvedValue([]);
        const install = installApp();
        const { container } = renderControl();
        await screen.findByText('No apps installed.');

        const html = appHtml({ grants: [BOARD, STATS] });
        pick(container, htmlFile('whatever.html', html));
        expect(await screen.findByText('Burn down')).toBeTruthy();
        expect(screen.getByText('It says: Counts the cards.')).toBeTruthy();
        fireEvent.click(screen.getByLabelText(/^Stats/));
        fireEvent.click(screen.getByRole('button', { name: 'Install' }));

        await waitFor(() =>
            expect(install).toHaveBeenCalledWith('burn-down', {
                name: 'Burn down',
                description: 'Cards left',
                html,
                grants: ['stats.read'],
                version: '1.0.0',
                apiVersion: 1,
            }),
        );
    });

    it('ticks nothing by default, and offers only what the app asks for', async () => {
        listApps().mockResolvedValue([]);
        const { container } = renderControl();
        await screen.findByText('No apps installed.');

        pick(container, htmlFile('a.html', appHtml({ grants: [BOARD] })));

        expect(((await screen.findByLabelText(/^Board/)) as HTMLInputElement).checked).toBe(false);
        expect(screen.queryByLabelText(/^Stats/)).toBeNull();
        expect(screen.queryByLabelText(/^Activity/)).toBeNull();
    });

    it('shows a grant this Wilson does not have without offering it', async () => {
        listApps().mockResolvedValue([]);
        const { container } = renderControl();
        await screen.findByText('No apps installed.');

        pick(container, htmlFile('a.html', appHtml({ grants: [BOARD, { grant: 'board.write', reason: 'Moves cards.' }] })));

        expect(await screen.findByText(/It also asks for board.write, which this Wilson does not have/)).toBeTruthy();
    });

    it('refuses a file with no manifest, saying what is missing', async () => {
        listApps().mockResolvedValue([]);
        const install = installApp();
        const { container } = renderControl();
        await screen.findByText('No apps installed.');

        pick(container, htmlFile('bare.html', '<h1>hello</h1>'));

        expect(await screen.findByText(/bare\.html: The file has no manifest/)).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(true);
        expect(install).not.toHaveBeenCalled();
    });

    it('warns about an app written for an API version this Wilson does not offer', async () => {
        listApps().mockResolvedValue([]);
        const { container } = renderControl();
        await screen.findByText('No apps installed.');

        pick(container, htmlFile('a.html', appHtml({ apiVersion: 2 })));

        expect(await screen.findByText('This Wilson cannot open it yet')).toBeTruthy();
    });

    it('cannot install without a file', async () => {
        listApps().mockResolvedValue([]);
        renderControl();
        await screen.findByText('No apps installed.');

        expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('refuses a file over the limit before sending anything', async () => {
        listApps().mockResolvedValue([]);
        const install = installApp();
        const { container } = renderControl();
        await screen.findByText('No apps installed.');

        pick(container, htmlFile('big.html', 'x'.repeat(MAX_APP_HTML_BYTES + 1)));

        expect(await screen.findByText(/big\.html is over the 512 KiB limit/)).toBeTruthy();
        expect(install).not.toHaveBeenCalled();
    });

    it('treats a file whose id is installed as a replace, with both versions and what it would gain', async () => {
        listApps().mockResolvedValue([{ ...burndown, slug: 'burn-down', version: '0.9.0' }]);
        const { container } = renderControl();
        await screen.findByText('Burndown');

        pick(container, htmlFile('a.html', appHtml({ grants: [BOARD, STATS] })));

        expect(await screen.findByText('This replaces Burndown')).toBeTruthy();
        expect(screen.getByText('0.9.0 → 1.0.0')).toBeTruthy();
        expect((screen.getByLabelText(/^Board/) as HTMLInputElement).checked).toBe(true);
        expect(screen.getByText('It would gain no new access.')).toBeTruthy();

        fireEvent.click(screen.getByLabelText(/^Stats/));

        expect(screen.getByText('It would gain access to: Stats.')).toBeTruthy();
    });

    it('drops a grant the new file no longer asks for, and says so', async () => {
        listApps().mockResolvedValue([{ ...burndown, slug: 'burn-down' }]);
        const { container } = renderControl();
        await screen.findByText('Burndown');

        pick(container, htmlFile('a.html', appHtml({ grants: [STATS] })));

        expect(await screen.findByText(/It would lose: Board\./)).toBeTruthy();
    });

    it('refuses a file for another app when replacing one', async () => {
        listApps().mockResolvedValue([burndown]);
        vi.spyOn(wilson.apps, 'getApp').mockResolvedValue(stored);
        const { container } = renderControl();
        await screen.findByText('Burndown');

        fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
        pick(container, htmlFile('other.html', appHtml({ id: 'other' })));

        expect(await screen.findByText(/other\.html is the app "other", not Burndown/)).toBeTruthy();
    });

    it('takes a grant back without a file, sending what is already stored', async () => {
        listApps().mockResolvedValue([burndown]);
        vi.spyOn(wilson.apps, 'getApp').mockResolvedValue({ ...stored, version: '1.2.0', apiVersion: 1 });
        const install = installApp();
        renderControl();
        await screen.findByText('Burndown');

        fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
        fireEvent.click(await screen.findByLabelText(/^Board/));
        expect(screen.getByText(/It would lose: Board\./)).toBeTruthy();
        const form = screen.getByLabelText(/^HTML file/).closest('form')!;
        await waitFor(() => expect((within(form).getByRole('button', { name: 'Replace' }) as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(within(form).getByRole('button', { name: 'Replace' }));

        await waitFor(() =>
            expect(install).toHaveBeenCalledWith('burndown', {
                name: 'Burndown',
                description: 'Cards left',
                html: '<h1>stored</h1>',
                grants: [],
                version: '1.2.0',
                apiVersion: 1,
            }),
        );
    });

    it('offers only what the stored manifest asks for when replacing without a file', async () => {
        listApps().mockResolvedValue([{ ...burndown, slug: 'burn-down' }]);
        vi.spyOn(wilson.apps, 'getApp').mockResolvedValue({ ...stored, slug: 'burn-down', html: appHtml({ grants: [BOARD] }) });
        renderControl();
        await screen.findByText('Burndown');

        fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

        expect(await screen.findByText('It says: Counts the cards.')).toBeTruthy();
        expect(screen.queryByLabelText(/^Stats/)).toBeNull();
    });

    it('asks before removing, and removes only on the second press', async () => {
        listApps().mockResolvedValue([burndown]);
        const remove = vi.spyOn(wilson.apps, 'removeApp').mockResolvedValue(undefined);
        renderControl();
        await screen.findByText('Burndown');

        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        expect(remove).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Remove Burndown' }));

        await waitFor(() => expect(remove).toHaveBeenCalledWith('burndown'));
    });

    it('keeps the app when the removal is called off', async () => {
        listApps().mockResolvedValue([burndown]);
        const remove = vi.spyOn(wilson.apps, 'removeApp').mockResolvedValue(undefined);
        renderControl();
        await screen.findByText('Burndown');

        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        fireEvent.click(screen.getByRole('button', { name: 'Keep' }));

        expect(remove).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    });

    it("shows the server's reason when an install is refused, keeping the form", async () => {
        listApps().mockResolvedValue([]);
        vi.spyOn(wilson.apps, 'installApp').mockRejectedValue(
            new SdkError(400, 'Bad Request', { details: { reason: 'a slug is 1 to 63 lowercase letters' } }, new Headers()),
        );
        const { container } = renderControl();
        await screen.findByText('No apps installed.');

        pick(container, htmlFile('a.html', appHtml()));
        await screen.findByText('Burn down');
        fireEvent.click(screen.getByRole('button', { name: 'Install' }));

        expect(await screen.findByText(/a slug is 1 to 63 lowercase letters/)).toBeTruthy();
        expect(screen.getByText('Burn down')).toBeTruthy();
    });
});

describe('app helpers', () => {
    it('finds only the grants being added', () => {
        expect(addedGrants(['board.read'], ['board.read', 'stats.read'])).toEqual(['stats.read']);
        expect(addedGrants(['board.read'], [])).toEqual([]);
    });
});
