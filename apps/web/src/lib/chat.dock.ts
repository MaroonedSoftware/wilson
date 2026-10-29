import { useSyncExternalStore } from 'react';

export type ChatDockPosition = 'right' | 'bottom';

export interface ChatDockState {
    open: boolean;
    position: ChatDockPosition;
    /** Docked on the right, in pixels. */
    width: number;
    /** Docked at the bottom, in pixels. */
    height: number;
}

export const DOCK_WIDTH = { min: 320, max: 720, initial: 420 };
export const DOCK_HEIGHT = { min: 200, max: 640, initial: 320 };

const STORAGE_KEY = 'wilson.chatDock';

const INITIAL: ChatDockState = { open: false, position: 'right', width: DOCK_WIDTH.initial, height: DOCK_HEIGHT.initial };

const clamp = (value: number, { min, max }: { min: number; max: number }) => Math.min(max, Math.max(min, Math.round(value)));

const read = (): ChatDockState => {
    try {
        const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ChatDockState>;
        return {
            open: stored.open === true,
            position: stored.position === 'bottom' ? 'bottom' : 'right',
            width: clamp(typeof stored.width === 'number' ? stored.width : DOCK_WIDTH.initial, DOCK_WIDTH),
            height: clamp(typeof stored.height === 'number' ? stored.height : DOCK_HEIGHT.initial, DOCK_HEIGHT),
        };
    } catch {
        return INITIAL;
    }
};

let dock = read();
const listeners = new Set<() => void>();

const update = (change: Partial<ChatDockState>): void => {
    dock = { ...dock, ...change };
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dock));
    } catch {
        // Storage can be unavailable (a private window); the dock keeps its state for this page load.
    }
    for (const listener of listeners) listener();
};

/**
 * The chat dock beside every page but the home page (`ChatDock.tsx`): whether it is open, where it
 * sits, and how big it is. A per-browser convenience kept in `localStorage`, as ats's
 * `chat.dock.store.ts` is, so the dock comes back the way it was left.
 */
export const setChatDockOpen = (open: boolean): void => update({ open });
export const toggleChatDock = (): void => update({ open: !dock.open });
export const setChatDockPosition = (position: ChatDockPosition): void => update({ position });

/** Resize the dock, held within {@link DOCK_WIDTH} and {@link DOCK_HEIGHT}. */
export const resizeChatDock = ({ width, height }: { width?: number; height?: number }): void =>
    update({
        ...(width !== undefined ? { width: clamp(width, DOCK_WIDTH) } : {}),
        ...(height !== undefined ? { height: clamp(height, DOCK_HEIGHT) } : {}),
    });

export function useChatDock(): ChatDockState {
    return useSyncExternalStore(
        listener => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => dock,
    );
}
