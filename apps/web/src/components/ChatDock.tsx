import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { ActionIcon, Box, Group, Tooltip } from '@mantine/core';
import { IconLayoutBottombar, IconLayoutSidebarRight, IconMaximize, IconMessageChatbot, IconX } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { ChatView } from '#src/components/ChatView.js';
import {
    DOCK_HEIGHT,
    DOCK_WIDTH,
    resizeChatDock,
    setChatDockOpen,
    setChatDockPosition,
    toggleChatDock,
    useChatDock,
    type ChatDockPosition,
} from '#src/lib/chat.dock.js';

/** How far one arrow-key press resizes the dock. */
const KEY_STEP = 24;

/** The dock's inner edge: drag it, or focus it and use the arrow keys, to resize the dock. */
function ResizeHandle({ position }: { position: ChatDockPosition }) {
    const dock = useChatDock();
    const dragging = useRef(false);
    const right = position === 'right';
    const resizeTo = (event: PointerEvent<HTMLDivElement>) =>
        resizeChatDock(right ? { width: window.innerWidth - event.clientX } : { height: window.innerHeight - event.clientY });
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const grow = right ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
        const shrink = right ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
        if (!grow && !shrink) return;
        event.preventDefault();
        const step = grow ? KEY_STEP : -KEY_STEP;
        resizeChatDock(right ? { width: dock.width + step } : { height: dock.height + step });
    };
    const limits = right ? DOCK_WIDTH : DOCK_HEIGHT;

    return (
        <Box
            role="separator"
            aria-orientation={right ? 'vertical' : 'horizontal'}
            aria-label="Resize the chat"
            aria-valuemin={limits.min}
            aria-valuemax={limits.max}
            aria-valuenow={right ? dock.width : dock.height}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={event => {
                dragging.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
                if (dragging.current) resizeTo(event);
            }}
            onPointerUp={event => {
                dragging.current = false;
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            style={{
                position: 'absolute',
                zIndex: 1,
                touchAction: 'none',
                ...(right
                    ? { left: -3, top: 0, bottom: 0, width: 6, cursor: 'col-resize' }
                    : { top: -3, left: 0, right: 0, height: 6, cursor: 'row-resize' }),
            }}
        />
    );
}

/** The dock's own controls, beside the thread picker: move it, open it as the home page, close it. */
function DockControls({ position }: { position?: ChatDockPosition }) {
    const navigate = useNavigate();
    return (
        <Group gap={2} wrap="nowrap">
            {position === 'right' && (
                <Tooltip label="Dock at the bottom">
                    <ActionIcon variant="subtle" aria-label="Dock at the bottom" onClick={() => setChatDockPosition('bottom')}>
                        <IconLayoutBottombar size={16} />
                    </ActionIcon>
                </Tooltip>
            )}
            {position === 'bottom' && (
                <Tooltip label="Dock on the right">
                    <ActionIcon variant="subtle" aria-label="Dock on the right" onClick={() => setChatDockPosition('right')}>
                        <IconLayoutSidebarRight size={16} />
                    </ActionIcon>
                </Tooltip>
            )}
            <Tooltip label="Open as the home page">
                <ActionIcon variant="subtle" aria-label="Open as the home page" onClick={() => void navigate({ to: '/' })}>
                    <IconMaximize size={16} />
                </ActionIcon>
            </Tooltip>
            <Tooltip label="Close the chat">
                <ActionIcon variant="subtle" aria-label="Close the chat" onClick={() => setChatDockOpen(false)}>
                    <IconX size={16} />
                </ActionIcon>
            </Tooltip>
        </Group>
    );
}

/**
 * The chat docked beside a page, as ats's `ChatDock` is: the same conversation as the home page
 * (`ChatView`'s panel variant, on the one active thread), so a person can watch a card move after
 * confirming the change that moved it. `position` is where it is docked; none means it fills a
 * full-screen drawer on a phone, where there is no room beside the page.
 */
export function ChatDock({ position, project }: { position?: ChatDockPosition; project?: string }) {
    return (
        <Box pos="relative" h="100%" aria-label="Chat" component="section">
            {position && <ResizeHandle position={position} />}
            <ChatView variant="panel" project={project} actions={<DockControls position={position} />} />
        </Box>
    );
}

/** The header's button for the dock, on every page but the home page. Ctrl/⌘+J does the same (`__root.tsx`). */
export function ChatDockToggle() {
    const { open } = useChatDock();
    return (
        <Tooltip label={open ? 'Hide the chat' : 'Chat'}>
            <ActionIcon
                variant={open ? 'light' : 'subtle'}
                aria-label={open ? 'Hide the chat' : 'Show the chat'}
                aria-pressed={open}
                onClick={toggleChatDock}
            >
                <IconMessageChatbot size={18} />
            </ActionIcon>
        </Tooltip>
    );
}
