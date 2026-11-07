// @vitest-environment jsdom
//
// The Android goal screens are meant to follow web's goal rules (card 0029). The app's own JUnit tests
// (apps/android/.../ui/goal/GoalTest.kt) check its logic on the JVM. They cannot check that the logic
// still matches web, because web's tables live here. So this test reads the Kotlin source and compares
// it with the web exports that the goal pages actually render from: STATUS_ACTIONS and isOpen.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Goal } from '@wilson/sdk';
import { isOpen } from '#src/lib/goals.js';
import { STATUS_ACTIONS } from '#src/routes/goals.$goalId.js';

const ANDROID_MAIN = join(import.meta.dirname, '../../android/app/src/main/kotlin/com/maroonedsoftware/wilson/');
const GOAL_DIR = join(ANDROID_MAIN, 'ui/goal');
const GOAL_MODEL = join(GOAL_DIR, 'GoalModel.kt');

const WIRE: Goal['status'][] = ['active', 'paused', 'done', 'abandoned'];

const read = (path: string) => readFileSync(path, 'utf8');

/** The body of a top-level Kotlin `fun name(...)`: everything from its signature to the next blank line. */
function functionBody(source: string, name: string): string {
    const start = source.search(new RegExp(`fun ${name}\\(`));
    expect(start, `fun ${name} in GoalModel.kt`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n\n', start);
    return source.slice(start, end === -1 ? undefined : end);
}

/** `when (status)` branches as status → right-hand side, with `A, B -> x` producing one entry for each status. */
function whenBranches(body: string): Map<string, string> {
    const branches = new Map<string, string>();
    for (const match of body.matchAll(/^\s*((?:GoalStatus\.\w+\s*,\s*)*GoalStatus\.\w+)\s*->\s*(.+)$/gm)) {
        for (const status of match[1]!.split(',')) branches.set(status.trim().replace('GoalStatus.', ''), match[2]!.trim());
    }
    return branches;
}

type AndroidAction = { to: string; label: string; done: string };

/** The named `GoalAction(...)` constants in GoalModel.kt. */
function actionConstants(source: string): Map<string, AndroidAction> {
    const constants = new Map<string, AndroidAction>();
    for (const match of source.matchAll(/val (\w+) = GoalAction\(UpdateGoalRequestStatus\.(\w+), "([^"]*)", "([^"]*)"\)/g)) {
        constants.set(match[1]!, { to: match[2]!.toLowerCase(), label: match[3]!, done: match[4]! });
    }
    return constants;
}

/** goalActions as a table keyed by the GoalStatus enum name, resolved through the constants. */
function androidActions(): Map<string, AndroidAction[]> {
    const source = read(GOAL_MODEL);
    const constants = actionConstants(source);
    const table = new Map<string, AndroidAction[]>();
    for (const [status, rhs] of whenBranches(functionBody(source, 'goalActions'))) {
        if (rhs === 'emptyList()') {
            table.set(status, []);
            continue;
        }
        const list = /^listOf\(([^)]*)\)$/.exec(rhs);
        expect(list, `goalActions branch for ${status}: ${rhs}`).not.toBeNull();
        table.set(
            status,
            list![1]!.split(',').map(name => {
                const action = constants.get(name.trim());
                expect(action, `GoalAction constant ${name.trim()}`).toBeDefined();
                return action!;
            }),
        );
    }
    return table;
}

function kotlinFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter(name => name.endsWith('.kt'))
        .map(name => join(dir, name));
}

describe('Android goal rules match web', () => {
    it('offers exactly the buttons web offers, in the same order, for each status', () => {
        const table = androidActions();
        for (const status of WIRE) {
            expect(
                table.get(status.toUpperCase())?.map(({ to, label }) => ({ to, label })),
                `actions for ${status}`,
            ).toEqual(STATUS_ACTIONS[status]);
        }
    });

    it('offers no action for a status the SDK does not know, and covers every status', () => {
        const table = androidActions();
        expect(table.get('UNKNOWN')).toEqual([]);
        expect([...table.keys()].sort()).toEqual(['ABANDONED', 'ACTIVE', 'DONE', 'PAUSED', 'UNKNOWN']);
    });

    it('gives every action a sentence for the snackbar', () => {
        const done = new Map<string, string>();
        for (const actions of androidActions().values()) for (const action of actions) done.set(action.label, action.done);
        expect(Object.fromEntries(done)).toEqual({
            Pause: 'Paused.',
            Resume: 'Resumed.',
            'Mark done': 'Marked done.',
            Abandon: 'Abandoned.',
            Reopen: 'Reopened.',
        });
    });

    it('counts the same statuses as open as web does, and never UNKNOWN', () => {
        const body = functionBody(read(GOAL_MODEL), 'isOpen');
        const open = new Set([...body.matchAll(/GoalStatus\.(\w+)/g)].map(match => match[1]!));
        for (const status of WIRE) expect(open.has(status.toUpperCase()), status).toBe(isOpen({ status }));
        expect(open.has('UNKNOWN')).toBe(false);
    });

    it("colours each status with the app's own tones", () => {
        const tones = whenBranches(functionBody(read(GOAL_MODEL), 'goalTone'));
        expect(Object.fromEntries(tones)).toEqual({
            ACTIVE: 'ActivityTone.GOOD',
            PAUSED: 'ActivityTone.WARNING',
            DONE: 'ActivityTone.INFO',
            ABANDONED: 'ActivityTone.QUIET',
            UNKNOWN: 'ActivityTone.QUIET',
        });
    });
});

describe('Android goal screens are wired in', () => {
    it('registers every Destination, the goal ones included, so a rotation restores it', () => {
        const source = read(join(ANDROID_MAIN, 'ui/nav/Destination.kt'));
        const declared = [...source.matchAll(/data (?:object|class) (\w+)\b[^\n]*: Destination/g)].map(match => match[1]!);
        expect(declared).toEqual(expect.arrayContaining(['Goals', 'Goal']));
        for (const name of declared) expect(source, `subclass for ${name}`).toContain(`subclass(Destination.${name}::class, Destination.${name}.serializer())`);
    });

    it('defines ActivityTone.colour once, shared by the activity and goal screens', () => {
        const files = kotlinFiles(ANDROID_MAIN);
        const definitions = files.filter(file => /fun ActivityTone\.colour\(\)/.test(read(file)));
        expect(definitions.map(file => file.slice(ANDROID_MAIN.length))).toEqual(['ui/Common.kt']);
        for (const screen of ['ui/activity/ActivityScreen.kt', 'ui/goal/GoalScreens.kt'])
            expect(read(join(ANDROID_MAIN, screen)), screen).toContain('import com.maroonedsoftware.wilson.ui.colour');
    });

    it('reaches Goals from the board without needing a project, and pushes it on the back stack', () => {
        const board = read(join(ANDROID_MAIN, 'ui/board/BoardScreen.kt'));
        expect(board).toContain('TextButton(onClick = onGoals) { Text("Goals") }');
        expect(read(join(ANDROID_MAIN, 'MainActivity.kt'))).toContain('onGoals = { backStack.add(Destination.Goals) }');
    });

    it('does not poll: the only delay in ui/goal settles a feed burst, and no refresh interval exists', () => {
        const sources = kotlinFiles(GOAL_DIR).map(read).join('\n');
        expect(sources).not.toMatch(/while\s*\(/);
        expect(sources).not.toMatch(/GOAL_REFRESH|REFRESH_MS|AGE_TICK/);
        expect([...sources.matchAll(/delay\((\w+)\)/g)].map(match => match[1])).toEqual(['RELOAD_SETTLE_MS']);
    });

    it('lists goals across projects: listGoals is called with no filter', () => {
        const model = read(GOAL_MODEL);
        expect(model).toContain('it.goals.listGoals()');
        expect(model).not.toContain('ListGoalsQuery');
    });

    it('puts the Goals button outside the project guard, between Activity and Chat', () => {
        const board = read(join(ANDROID_MAIN, 'ui/board/BoardScreen.kt'));
        const activity = board.indexOf('Text("Activity")');
        const goals = board.indexOf('Text("Goals")');
        const chat = board.indexOf('Text("Chat")');
        expect(activity).toBeGreaterThanOrEqual(0);
        expect(goals).toBeGreaterThan(activity);
        expect(chat).toBeGreaterThan(goals);
        // The `state.project?.let { ... }` block that holds Activity closes before Goals is drawn.
        const guard = board.lastIndexOf('state.project?.let', goals);
        let depth = 0;
        let closed = -1;
        for (let i = board.indexOf('{', guard); i < board.length; i++) {
            if (board[i] === '{') depth++;
            else if (board[i] === '}' && --depth === 0) {
                closed = i;
                break;
            }
        }
        expect(closed).toBeGreaterThan(activity);
        expect(closed).toBeLessThan(goals);
    });

    it('opens a goal with its own keyed model, its cards in the goal project, and its thread in chat', () => {
        const main = read(join(ANDROID_MAIN, 'MainActivity.kt'));
        expect(main).toContain('entry<Destination.Goals>');
        expect(main).toContain('onGoal = { id -> backStack.add(Destination.Goal(id)) }');
        expect(main).toContain('entry<Destination.Goal>');
        expect(main).toContain('key = "goal:${key.id}"');
        expect(main).toContain('GoalModel(app, key.id)');
        expect(main).toContain('onCard = { project, id -> backStack.add(Destination.Card(project, id)) }');
        expect(main).toContain('onConversation = { threadId -> backStack.add(Destination.Chat(threadId)) }');

        const screens = read(join(GOAL_DIR, 'GoalScreens.kt'));
        expect(screens).toContain('onCard(goal.project, card.id)');
        expect(screens).toContain('onConversation(it.threadId)');
    });

    it("uses web's copy and draws Finished only when something is finished", () => {
        const screens = read(join(GOAL_DIR, 'GoalScreens.kt'));
        expect(screens).toContain('"No goals yet. Ask the chat to start one for work that will take several cards."');
        expect(screens).toContain('"No cards yet. Ask in the conversation to add some."');
        expect(screens).toContain('"What done looks like"');
        expect(screens).toContain('"needs you"');
        const heading = screens.indexOf('Text("Finished"');
        expect(heading).toBeGreaterThanOrEqual(0);
        expect(screens.lastIndexOf('if (finished.isNotEmpty())', heading)).toBeGreaterThanOrEqual(0);
    });

    it('re-reads the goal on start and after a change, holds the snackbar long, and disables buttons while acting', () => {
        const screens = read(join(GOAL_DIR, 'GoalScreens.kt'));
        expect(screens).toMatch(/repeatOnLifecycle\(Lifecycle\.State\.STARTED\)\s*\{\s*model\.reload\(\)\s*model\.follow\(\)/);
        expect(screens).toContain('LifecycleResumeEffect');
        expect(screens).toContain('SnackbarDuration.Long');
        expect(screens).toContain('enabled = !state.acting');

        const change = functionBody(read(GOAL_MODEL), 'change');
        expect(change).toContain('UpdateGoalRequest(status = action.to)');
        expect(change.indexOf('reload()')).toBeGreaterThan(change.indexOf('updateAGoal'));
        expect(change.indexOf('notices.emit(note)')).toBeGreaterThan(change.indexOf('reload()'));
    });

    it("follows the goal's own project feed and skips tool events", () => {
        const follow = read(GOAL_MODEL).slice(read(GOAL_MODEL).indexOf('suspend fun follow()'));
        expect(follow).toContain('it.detail?.goal?.project');
        expect(follow).toContain('"/api/feed", project');
        expect(follow).toContain('!isToolEvent(');
        expect(follow).not.toContain('correlationId');
    });
});
