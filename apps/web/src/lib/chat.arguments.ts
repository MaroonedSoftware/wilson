/** How a proposed action's argument is best read: beside its label, as Markdown, or as indented JSON. */
export type ChatFieldKind = 'line' | 'prose' | 'json';

/** One argument of a proposed action, as a person reads it. */
export interface ChatActionField {
    label: string;
    value: string;
    kind: ChatFieldKind;
}

/** Past this a string is prose even on one line, and would not sit beside its label. */
const LONGEST_LINE = 120;

const KIND_ORDER: Record<ChatFieldKind, number> = { line: 0, prose: 1, json: 2 };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The arguments exactly as recorded, for when the fields are not enough. */
export const prettyArguments = (args: unknown): string => JSON.stringify(args, null, 2);

/** `webAccess` and `web_access` as `Web access`, and `cardId` as `Card ID`. */
export function fieldLabel(name: string): string {
    const words = name
        .split(/(?<=[a-z0-9])(?=[A-Z])|[_\-\s]+/)
        .filter(Boolean)
        .map(word => word.toLowerCase())
        .map(word => (word === 'id' ? 'ID' : word));
    if (words.length === 0) return name;
    const [first, ...rest] = words as [string, ...string[]];
    return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/** A request's `body` is an API detail and is opened, unless that would leave two arguments of one name. */
function opened(args: Record<string, unknown>): [string, unknown][] {
    const entries = Object.entries(args);
    const body = args['body'];
    if (!isObject(body)) return entries;
    const inner = Object.entries(body);
    if (inner.some(([name]) => name !== 'body' && name in args)) return entries;
    return entries.flatMap((entry): [string, unknown][] => (entry[0] === 'body' ? inner : [entry]));
}

function field(name: string, value: unknown): ChatActionField {
    const label = fieldLabel(name);
    if (typeof value === 'string') {
        if (value.length === 0) return { label, value: '(empty)', kind: 'line' };
        return { label, value, kind: value.includes('\n') || value.length > LONGEST_LINE ? 'prose' : 'line' };
    }
    if (value === null) return { label, value: 'none', kind: 'line' };
    if (typeof value === 'object') return { label, value: prettyArguments(value), kind: 'json' };
    return { label, value: String(value), kind: 'line' };
}

/**
 * A proposed action's arguments for the person deciding on it. Every argument is shown, since Confirm
 * runs exactly what is on the card. Short values come first: stored arguments are in jsonb's order,
 * which is no order a person would pick, and a long body would push the rest out of sight. The same
 * rules as the desktop app's `ChatArguments`.
 */
export function actionFields(args: unknown): ChatActionField[] {
    if (!isObject(args)) return [{ label: 'Arguments', value: prettyArguments(args), kind: 'json' }];
    return opened(args)
        .map(([name, value]) => field(name, value))
        .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}
