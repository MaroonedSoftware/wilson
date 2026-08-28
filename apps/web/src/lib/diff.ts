/**
 * A minimal line-level diff, LCS-based, with no context lines — just what was added and removed.
 * `DraftPane.tsx`'s own small module, per this card's Constraints: Mantine has no diff component,
 * so something must render one, and the terminal's `diffLines` (`plan.command.ts`,
 * `packages/cli/src/commands/card/plan.command.ts`) already does exactly this, well enough to be
 * worth copying rather than a third implementation or a shared dependency for ten lines.
 *
 * A deliberate copy, not a shared import: `plan.command.ts` is not reachable from `apps/web`
 * without crossing the app/CLI boundary card 0085 drew.
 *
 * When this was written the duplication was expected to be temporary — card 0125 would retire
 * `wilson card plan` and take the terminal's `diffLines` with it. **That is no longer happening.**
 * 0125 was decided against on 2026-08-27: the terminal session stays, because planning over SSH and
 * the Claude Code TUI are worth more than removing a second client. So this duplicate is permanent,
 * on purpose, and the reason to leave it alone is now stronger rather than weaker — sharing ten
 * lines across the app/CLI boundary buys less than the boundary is worth. Do not "finish the
 * cleanup"; there is none pending.
 *
 * Returns structured lines rather than the terminal's pre-formatted `"- "`/`"+ "` strings, since a
 * Mantine render needs the added/removed distinction as data (for colour), not as a text prefix.
 */
export interface DiffLine {
    kind: 'add' | 'remove';
    text: string;
}

export const diffLines = (before: string, after: string): DiffLine[] => {
    const a = before.split('\n');
    const b = after.split('\n');
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
        }
    }

    const lines: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            i += 1;
            j += 1;
        } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
            lines.push({ kind: 'remove', text: a[i]! });
            i += 1;
        } else {
            lines.push({ kind: 'add', text: b[j]! });
            j += 1;
        }
    }
    while (i < a.length) {
        lines.push({ kind: 'remove', text: a[i]! });
        i += 1;
    }
    while (j < b.length) {
        lines.push({ kind: 'add', text: b[j]! });
        j += 1;
    }
    return lines;
};
