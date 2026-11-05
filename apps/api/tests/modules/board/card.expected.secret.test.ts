import { describe, expect, it } from 'vitest';
import { expectedSecretPaths, type Card } from '#modules/board/card.js';
import { planlessCard } from '#tests/modules/stages/stage.fixture.js';

const withConstraints = (constraints: string): Card => ({ ...planlessCard(), sections: { Constraints: constraints } });

describe('expectedSecretPaths', () => {
    it('reads each declared path, with or without backticks', () => {
        const card = withConstraints(
            '- Expected secret: `tests/a.pem` (a parser fixture)\n- expected secret: tests/(b)/c.ts (a fake key)\n- Keep it small',
        );
        expect(expectedSecretPaths(card)).toEqual(['tests/a.pem', 'tests/(b)/c.ts']);
    });

    it.each(['- Expected secret: tests/a.pem', '- Expected secret: tests/a.pem ()', '- Expected secret: (a reason)'])('refuses %s', bullet => {
        expect(expectedSecretPaths(withConstraints(bullet))).toEqual([]);
    });

    it('is empty for a plan with no Constraints', () => {
        expect(expectedSecretPaths(planlessCard())).toEqual([]);
    });
});
