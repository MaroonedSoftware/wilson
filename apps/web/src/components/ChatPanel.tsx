import { useState } from 'react';
import { ActionIcon, Box, Drawer, Tooltip } from '@mantine/core';
import { IconMessageChatbot } from '@tabler/icons-react';
import { ChatView } from '#src/components/ChatView.js';

/**
 * The header's Chat button: the chat (`ChatView`) in a drawer beside whatever page is open. Rendered
 * by the root layout on every page, so `project` is whichever project the matched route carries.
 * The drawer renders nothing while closed, so the chat reads nothing until it is opened.
 */
export function ChatPanel({ project }: { project?: string }) {
    const [opened, setOpened] = useState(false);

    return (
        <>
            <Tooltip label="Chat">
                <ActionIcon onClick={() => setOpened(true)} variant="subtle" aria-label="Chat">
                    <IconMessageChatbot size={18} />
                </ActionIcon>
            </Tooltip>
            <Drawer opened={opened} onClose={() => setOpened(false)} position="right" size="lg" title="Chat" padding={0}>
                <Box h="calc(100vh - 70px)">
                    <ChatView variant="panel" project={project} />
                </Box>
            </Drawer>
        </>
    );
}
