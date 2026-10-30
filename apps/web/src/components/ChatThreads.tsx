import { useState } from 'react';
import { ActionIcon, Button, Menu, Modal, NavLink, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { IconArchive, IconDots, IconMessages, IconPencil, IconPlus } from '@tabler/icons-react';
import type { ChatThread } from '@wilson/sdk';
import { setActiveThread, useArchiveChatThread, useRenameChatThread } from '#src/lib/chat.js';

/** Archives a thread, letting go of it if it is the one open. */
function useArchive(activeThreadId: string | undefined) {
    const archive = useArchiveChatThread();
    return (threadId: string) =>
        archive.mutate(threadId, {
            onSuccess: () => {
                if (threadId === activeThreadId) setActiveThread(undefined);
            },
        });
}

/** The person's threads, most recent first, down the side of the full-page chat. */
export function ThreadList({ threads, activeThreadId }: { threads: ChatThread[]; activeThreadId?: string }) {
    const archive = useArchive(activeThreadId);
    const rename = useRenameChatThread();
    const [renaming, setRenaming] = useState<ChatThread>();
    const [title, setTitle] = useState('');
    const submitRename = () => {
        if (renaming && title.trim()) rename.mutate({ threadId: renaming.id, title: title.trim() });
        setRenaming(undefined);
    };

    return (
        <Stack gap="xs" h="100%">
            <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => setActiveThread(undefined)} justify="flex-start">
                New chat
            </Button>
            <ScrollArea style={{ flex: 1 }} type="auto">
                <nav aria-label="Chats">
                    {threads.length === 0 ? (
                        <Text size="sm" c="dimmed" px="sm" py="xs">
                            Your chats will show here.
                        </Text>
                    ) : (
                        threads.map(thread => (
                            <NavLink
                                key={thread.id}
                                component="button"
                                active={thread.id === activeThreadId}
                                aria-current={thread.id === activeThreadId ? 'page' : undefined}
                                label={
                                    <Text size="sm" truncate>
                                        {thread.title}
                                    </Text>
                                }
                                description={thread.updatedAt.toRelative() ?? undefined}
                                onClick={() => setActiveThread(thread.id)}
                                rightSection={
                                    <Menu position="bottom-end" withinPortal>
                                        <Menu.Target>
                                            <ActionIcon
                                                component="span"
                                                role="button"
                                                variant="subtle"
                                                size="sm"
                                                aria-label={`Options for ${thread.title}`}
                                                onClick={event => event.stopPropagation()}
                                            >
                                                <IconDots size={14} />
                                            </ActionIcon>
                                        </Menu.Target>
                                        <Menu.Dropdown onClick={event => event.stopPropagation()}>
                                            <Menu.Item
                                                leftSection={<IconPencil size={14} />}
                                                onClick={() => {
                                                    setTitle(thread.title);
                                                    setRenaming(thread);
                                                }}
                                            >
                                                Rename
                                            </Menu.Item>
                                            <Menu.Item leftSection={<IconArchive size={14} />} onClick={() => archive(thread.id)}>
                                                Archive
                                            </Menu.Item>
                                        </Menu.Dropdown>
                                    </Menu>
                                }
                            />
                        ))
                    )}
                </nav>
            </ScrollArea>
            <Modal opened={renaming !== undefined} onClose={() => setRenaming(undefined)} title="Rename chat" size="sm">
                <form
                    onSubmit={event => {
                        event.preventDefault();
                        submitRename();
                    }}
                >
                    <Stack>
                        <TextInput
                            label="Name"
                            value={title}
                            onChange={event => setTitle(event.currentTarget.value)}
                            maxLength={120}
                            data-autofocus
                        />
                        <Button type="submit" disabled={!title.trim()}>
                            Save
                        </Button>
                    </Stack>
                </form>
            </Modal>
        </Stack>
    );
}

/** The threads where there is no room for the rail: the dock, and the page on a phone. */
export function ThreadMenu({ threads, activeThreadId }: { threads: ChatThread[]; activeThreadId?: string }) {
    const archive = useArchive(activeThreadId);
    const title = threads.find(thread => thread.id === activeThreadId)?.title ?? 'New chat';

    return (
        <Menu position="bottom-start" withinPortal>
            <Menu.Target>
                <Button
                    variant="subtle"
                    size="compact-sm"
                    leftSection={<IconMessages size={16} />}
                    aria-label={`Chats: ${title}`}
                    style={{ minWidth: 0 }}
                >
                    <Text size="sm" truncate>
                        {title}
                    </Text>
                </Button>
            </Menu.Target>
            <Menu.Dropdown mah={360} style={{ overflowY: 'auto' }}>
                <Menu.Item leftSection={<IconPlus size={14} />} onClick={() => setActiveThread(undefined)}>
                    New chat
                </Menu.Item>
                {threads.length > 0 && <Menu.Divider />}
                {threads.map(thread => (
                    <Menu.Item key={thread.id} onClick={() => setActiveThread(thread.id)} fw={thread.id === activeThreadId ? 600 : undefined}>
                        {thread.title}
                    </Menu.Item>
                ))}
                {activeThreadId && (
                    <>
                        <Menu.Divider />
                        <Menu.Item leftSection={<IconArchive size={14} />} onClick={() => archive(activeThreadId)}>
                            Archive this chat
                        </Menu.Item>
                    </>
                )}
            </Menu.Dropdown>
        </Menu>
    );
}
