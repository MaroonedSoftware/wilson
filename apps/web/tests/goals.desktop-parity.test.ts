// The desktop app's goals page follows this app's (`apps/desktop/CLAUDE.md`, "Against the web app"), and
// `GoalRules.cs` keeps `lib/goals.ts` "in step by hand". This holds the two to the same statuses, colours,
// refresh and wording, so a change on one side that is not made on the other fails here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Goal } from '@wilson/sdk';
import { GOAL_REFRESH_MS, isOpen, statusColor } from '#src/lib/goals.js';

const desktop = (path: string) => readFileSync(new URL(`../../desktop/src/${path}`, import.meta.url), 'utf8');

const rules = () => desktop('MaroonedSoftware.Wilson.Desktop.Core/Goals/GoalRules.cs');

const STATUSES: Goal['status'][] = ['active', 'paused', 'done', 'abandoned'];
const pascal = (status: string) => status[0]!.toUpperCase() + status.slice(1);

/** The arms of the C# switch in `method`: `GoalStatus.X => "y"`, and `_ => "z"` under `_`. */
function switchArms(source: string, method: string): Map<string, string> {
    const start = source.indexOf(`public static string ${method}(`);
    expect(start, `${method} is in GoalRules.cs`).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf('};', start));
    const arms = new Map<string, string>();
    for (const [, status, value] of body.matchAll(/(GoalStatus\.\w+|_)\s*=>\s*"([^"]*)"/g)) {
        arms.set(status!.replace('GoalStatus.', ''), value!);
    }
    return arms;
}

/** What a status maps to, falling to the discard arm as the C# switch does. */
const arm = (arms: Map<string, string>, status: string) => arms.get(pascal(status)) ?? arms.get('_');

describe('the desktop goal rules against lib/goals.ts', () => {
    it('draws each status in the colour statusColor gives it', () => {
        const arms = switchArms(rules(), 'StatusColor');

        for (const status of STATUSES) {
            expect(arm(arms, status), status).toBe(statusColor(status));
        }
        expect(arms.get('_')).toBe('gray');
    });

    it('gives each status a different colour where the web does', () => {
        const arms = switchArms(rules(), 'StatusColor');

        expect(new Set(STATUSES.map(status => arm(arms, status))).size).toBe(new Set(STATUSES.map(statusColor)).size);
    });

    it('spells each status as the server and the web badge do', () => {
        const arms = switchArms(rules(), 'StatusText');

        for (const status of STATUSES) {
            expect(arm(arms, status), status).toBe(status);
        }
    });

    it('counts the same statuses open as isOpen', () => {
        const source = rules();
        const start = source.indexOf('public static bool IsOpen(');
        expect(start).toBeGreaterThanOrEqual(0);
        const body = source.slice(start, source.indexOf('\n    }', start));
        const open = [...body.matchAll(/GoalStatus\.(\w+)/g)].map(([, status]) => status!.toLowerCase());

        expect(open.sort()).toEqual(STATUSES.filter(status => isOpen({ status })).sort());
    });

    it('re-reads as often as GOAL_REFRESH_MS', () => {
        const refresh = /Refresh\s*=\s*TimeSpan\.From(Seconds|Milliseconds)\(([\d_]+)\)/.exec(rules());
        expect(refresh, 'GoalRules.Refresh is a TimeSpan').not.toBeNull();

        const [, unit, amount] = refresh!;
        const ms = Number(amount!.replaceAll('_', '')) * (unit === 'Seconds' ? 1000 : 1);
        expect(ms).toBe(GOAL_REFRESH_MS);
    });
});

describe('the desktop goals page against routes/goals.index.tsx', () => {
    const view = () => desktop('MaroonedSoftware.Wilson.Desktop/Views/GoalsView.axaml');
    const route = () => readFileSync(new URL('../src/routes/goals.index.tsx', import.meta.url), 'utf8');

    it('says the same thing when there are no goals', () => {
        const empty = /No goals yet\.[^<"]*/.exec(route())![0].trim();

        expect(view()).toContain(`Text="${empty}"`);
    });

    it('names each row as the web does, so the Walk and a screen reader find it the same way', () => {
        expect(route()).toContain('aria-label={`goal ${goal.title}`}');
        expect(view()).toContain(`AutomationProperties.Name="{Binding Title, StringFormat='goal {0}'}"`);
    });

    it('is opened from a Goals button in the header', () => {
        const shell = desktop('MaroonedSoftware.Wilson.Desktop/Views/ShellView.axaml');

        expect(shell).toMatch(/<Button[^>]*Content="Goals"[^>]*Command="\{Binding ShowGoalsCommand\}"/);
    });
});
