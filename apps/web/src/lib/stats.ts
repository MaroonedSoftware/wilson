/** 1,234,567 as `1.2M`, for a tile or an axis, where the exact figure is in the tables below it. */
export const compactTokens = (tokens: number): string =>
    new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);

/** `part` of `whole` as a whole percentage, or undefined when there is no `whole` to be a share of. */
export const percentOf = (part: number, whole: number): number | undefined => (whole === 0 ? undefined : Math.round((part / whole) * 100));

/**
 * The top of a chart's axis: the first of 1, 2, 2.5 or 5 times a power of ten at or above `max`, so
 * its halfway tick is a clean number too.
 */
export const axisTop = (max: number): number => {
    if (max <= 0) return 1;
    const power = 10 ** Math.floor(Math.log10(max));
    return ([1, 2, 2.5, 5, 10].find(step => step * power >= max) ?? 10) * power;
};
