import { useEffect, useRef, useState } from 'react';
import { Modal, Stack, Text } from '@mantine/core';
import { CredentialsSteps } from '#src/components/AuthGate.js';
import { setStepUpHandler } from '#src/lib/session.js';

/**
 * "Confirm it's you." Adding or removing a second factor needs a factor proved in the last five
 * minutes (`wilson.step.up`). When a request is refused for want of one, `sessionFetch` asks this
 * dialog, which signs in again (password, and code if one is enrolled) and lets the request be
 * replayed with the fresh session. Cancelling leaves the request refused.
 *
 * Mounted once, in the app shell, so it is there for any screen that needs it.
 */
export function StepUpDialog() {
    const [open, setOpen] = useState(false);
    const settle = useRef<((confirmed: boolean) => void) | undefined>(undefined);

    useEffect(() => {
        setStepUpHandler(
            () =>
                new Promise<boolean>(resolve => {
                    settle.current = resolve;
                    setOpen(true);
                }),
        );
        return () => setStepUpHandler(undefined);
    }, []);

    const finish = (confirmed: boolean) => {
        setOpen(false);
        settle.current?.(confirmed);
        settle.current = undefined;
    };

    return (
        <Modal opened={open} onClose={() => finish(false)} title="Confirm it's you" centered>
            <Stack gap="sm">
                <Text size="sm" c="dimmed">
                    This change needs you to sign in again.
                </Text>
                {open && <CredentialsSteps submitLabel="Continue" onSignedIn={() => finish(true)} />}
            </Stack>
        </Modal>
    );
}
