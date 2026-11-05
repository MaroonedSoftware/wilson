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
import { addedGrants, MAX_APP_HTML_BYTES, nameFromFilename, slugFromFilename } from '#src/lib/apps.js';
import { wilson } from '#src/lib/sdk.js';
import { WilsonSdkProvider } from '#src/lib/sdk-context.js';

/** The settings page's Apps section (`AppsControl`): installing, replacing and removing operator apps. */

const NOW = DateTime.fromISO('2026-11-05T00:00:00.000Z');
const burndown: AppSummary = {
    slug: 'burndown',
    name: 'Burndown',
    description: 'Cards left',
    grants: ['board.read'],
    createdAt: NOW,
    updatedAt: NOW,
};
const stored: App = { ...burndown, html: '<h1>stored</h1>' };

const renderControl = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        createElement(
            MantineProvider,
            null,
            createElement(
                QueryClientProvider,
                { client },
                createElement(WilsonSdkProvider, { client: wilson, children: createElement(AppsControl) }),
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

    it('installs a file with only the grants ticked, suggesting a slug and name from its filename', async () => {
        listApps().mockResolvedValue([]);
        const install = installApp();
        const { container } = renderControl();
        await screen.findByText('No apps installed.');

        pick(container, htmlFile('Burn Down.html', '<h1>new</h1>'));
        expect((screen.getByLabelText(/^Slug/) as HTMLInputElement).value).toBe('burn-down');
        expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Burn Down');
        fireEvent.click(screen.getByLabelText(/^Stats/));
        fireEvent.click(screen.getByRole('button', { name: 'Install' }));

        await waitFor(() => expect(install).toHaveBeenCalledWith('burn-down', { name: 'Burn Down', html: '<h1>new</h1>', grants: ['stats.read'] }));
    });

    it('ticks nothing by default', async () => {
        listApps().mockResolvedValue([]);
        const { container } = renderControl();
        await screen.findByText('No apps installed.');

        pick(container, htmlFile('a.html', 'x'));

        for (const label of [/^Board/, /^Activity/, /^Stats/]) expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
    });

    it('cannot install without a file', async () => {
        listApps().mockResolvedValue([]);
        renderControl();
        await screen.findByText('No apps installed.');

        fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: 'burndown' } });
        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Burndown' } });

        expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('refuses a file over the limit before sending anything', async () => {
        listApps().mockResolvedValue([]);
        const install = installApp();
        const { container } = renderControl();
        await screen.findByText('No apps installed.');

        pick(container, htmlFile('big.html', 'x'.repeat(MAX_APP_HTML_BYTES + 1)));

        expect(await screen.findByText(/big\.html is over the 512 KiB limit/)).toBeTruthy();
        expect((screen.getByLabelText(/^Slug/) as HTMLInputElement).value).toBe('');
        expect(install).not.toHaveBeenCalled();
    });

    it('names the grants a replace would add', async () => {
        listApps().mockResolvedValue([burndown]);
        renderControl();
        await screen.findByText('Burndown');

        fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
        expect(screen.getByText('This replaces Burndown')).toBeTruthy();
        expect(screen.getByText('It would gain no new access.')).toBeTruthy();

        fireEvent.click(screen.getByLabelText(/^Stats/));

        expect(screen.getByText('It would gain access to: Stats.')).toBeTruthy();
    });

    it('treats typing an installed slug as a replace', async () => {
        listApps().mockResolvedValue([burndown]);
        renderControl();
        await screen.findByText('Burndown');

        fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: 'burndown' } });

        expect(screen.getByText('This replaces Burndown')).toBeTruthy();
    });

    it('takes a grant back without a file, sending the HTML already stored', async () => {
        listApps().mockResolvedValue([burndown]);
        vi.spyOn(wilson.apps, 'getApp').mockResolvedValue(stored);
        const install = installApp();
        renderControl();
        await screen.findByText('Burndown');

        fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
        fireEvent.click(screen.getByLabelText(/^Board/));
        const form = screen.getByLabelText(/^Slug/).closest('form')!;
        fireEvent.click(within(form).getByRole('button', { name: 'Replace' }));

        await waitFor(() =>
            expect(install).toHaveBeenCalledWith('burndown', { name: 'Burndown', description: 'Cards left', html: '<h1>stored</h1>', grants: [] }),
        );
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

        pick(container, htmlFile('a.html', 'x'));
        fireEvent.click(screen.getByRole('button', { name: 'Install' }));

        expect(await screen.findByText(/a slug is 1 to 63 lowercase letters/)).toBeTruthy();
        expect((screen.getByLabelText(/^Slug/) as HTMLInputElement).value).toBe('a');
    });
});

describe('app helpers', () => {
    it.each([
        ['Burn Down.html', 'burn-down'],
        ['report.HTM', 'report'],
        ['--Weird__name!!.html', 'weird-name'],
        ['日本語.html', ''],
    ])('suggests a slug for %s', (filename, slug) => {
        expect(slugFromFilename(filename)).toBe(slug);
    });

    it('keeps a suggested slug within the limit, with no trailing hyphen', () => {
        const slug = slugFromFilename(`${'a'.repeat(62)} b.html`);
        expect(slug).toBe('a'.repeat(62));
    });

    it('suggests a name without the extension', () => {
        expect(nameFromFilename('Burn Down.html')).toBe('Burn Down');
    });

    it('finds only the grants being added', () => {
        expect(addedGrants(['board.read'], ['board.read', 'stats.read'])).toEqual(['stats.read']);
        expect(addedGrants(['board.read'], [])).toEqual([]);
    });
});
