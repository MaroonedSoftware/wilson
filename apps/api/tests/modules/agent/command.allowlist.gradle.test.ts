import { describe, expect, it } from 'vitest';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { KOTLIN_TEST_COMMAND } from '#modules/stages/testing.verifier.js';

/**
 * Card 0037: a testing stage may run the Android app's Kotlin unit tests, but only as the one fixed
 * invocation. Gradle's trailing arguments run other build logic, so a gradle entry is matched
 * verbatim rather than as a prefix the way pnpm's are.
 */
describe('CommandAllowlist — gradle (card 0037)', () => {
    const list = new CommandAllowlist(['pnpm build', 'pnpm exec vitest run', KOTLIN_TEST_COMMAND]);

    it('allows the configured gradle command exactly', () => {
        expect(list.check(KOTLIN_TEST_COMMAND)).toMatchObject({
            allowed: true,
            argv: ['apps/android/gradlew', '-p', 'apps/android', ':app:testDebugUnitTest'],
        });
    });

    it.each([
        `${KOTLIN_TEST_COMMAND} --init-script evil.gradle`,
        `${KOTLIN_TEST_COMMAND} -Dorg.gradle.jvmargs=-Xmx1m`,
        `${KOTLIN_TEST_COMMAND} :app:assembleRelease`,
        `${KOTLIN_TEST_COMMAND} --tests`,
    ])('refuses the gradle command with anything appended: %s', command => {
        const decision = list.check(command);
        expect(decision.allowed).toBe(false);
        expect(decision).toMatchObject({ reason: expect.stringContaining(`exactly as configured`) });
        expect(decision).toMatchObject({ reason: expect.stringContaining(KOTLIN_TEST_COMMAND) });
    });

    it('refuses another gradle task, naming the one it may run', () => {
        const decision = list.check('apps/android/gradlew -p apps/android :app:connectedAndroidTest');
        expect(decision).toMatchObject({ allowed: false, reason: expect.stringContaining(KOTLIN_TEST_COMMAND) });
    });

    it('refuses ./gradlew and bare gradle, which are not the configured spelling', () => {
        expect(list.check('./gradlew :app:testDebugUnitTest').allowed).toBe(false);
        expect(list.check('gradle :app:testDebugUnitTest').allowed).toBe(false);
    });

    it('still lets a pnpm prefix take trailing arguments', () => {
        expect(list.check('pnpm exec vitest run apps/api/tests/x.test.ts')).toMatchObject({ allowed: true });
    });

    it('refuses gradle with the generic message when the stage lists none', () => {
        const decision = new CommandAllowlist(['pnpm build']).check(KOTLIN_TEST_COMMAND);
        expect(decision).toMatchObject({ allowed: false, reason: expect.stringContaining("not in this stage's allowlist") });
    });
});
