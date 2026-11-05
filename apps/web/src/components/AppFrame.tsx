import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, useComputedColorScheme } from '@mantine/core';
import type { AppGrant } from '@wilson/sdk';
import { serveApp } from '#src/lib/app.broker.js';
import { APP_CONNECT_MESSAGE, appDocument, APP_SANDBOX, type AppEvent } from '#src/lib/apps.js';
import { useBoardChanges } from '#src/lib/feed.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

/** How long the board has to stay quiet before an app is told it changed. */
export const APP_CHANGE_SETTLE_MS = 300;

/**
 * One operator app, running in a sandboxed iframe. The sandbox gives it an opaque origin, so it can
 * reach none of this page's cookies, storage or DOM, and `appDocument`'s policy refuses its requests.
 * All it has is the private port handed to it on load, and `serveApp` answers only what `grants` allow,
 * through the SDK client this component was given, so the app never holds a credential.
 *
 * That policy lives in the document, so it cannot stop the frame navigating itself somewhere else,
 * and neither can the sandbox. The page's own `frame-src 'none'` header does (`deploy/web.nginx.conf`,
 * `vite.config.ts`), and the attempt still fires a load. An app has one document for its whole life, so
 * a second load means it tried: the port is closed before whatever loaded could ask for anything, and
 * the frame is taken away.
 *
 * The app is told when the board changes and when the colour scheme does, both over the port. A change
 * goes only to an app with a grant, since even its timing says something about the board. The scheme
 * in the document stays the one it started with, because changing `srcDoc` would reload the frame.
 */
export function AppFrame({ name, html, project, grants }: { name: string; html: string; project: string; grants: readonly AppGrant[] }) {
    const client = useWilsonSdk();
    const loads = useRef(0);
    const port = useRef<MessagePort | undefined>(undefined);
    const [left, setLeft] = useState(false);
    const [attempt, setAttempt] = useState(0);
    // Not in an effect, or the first render reports 'light' and an app on a dark page starts light.
    const colorScheme = useComputedColorScheme('light', { getInitialValueInEffect: false });
    const [firstColorScheme] = useState(colorScheme);
    const changes = useBoardChanges();
    const seenChanges = useRef(changes);
    const mayHearChanges = grants.length > 0;

    const tell = (event: AppEvent) => port.current?.postMessage(event);

    useEffect(() => () => port.current?.close(), []);

    useEffect(() => {
        tell({ event: 'colorScheme', colorScheme });
    }, [colorScheme]);

    // Trailing, because a feed that has just connected replays one event per card.
    useEffect(() => {
        if (!mayHearChanges || changes === seenChanges.current) return;
        seenChanges.current = changes;
        const timer = setTimeout(() => tell({ event: 'change' }), APP_CHANGE_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [changes, mayHearChanges]);

    const onLoad = (frame: HTMLIFrameElement) => {
        loads.current += 1;
        if (loads.current > 1) {
            port.current?.close();
            setLeft(true);
            return;
        }
        const channel = new MessageChannel();
        serveApp(channel.port1, grants, client);
        port.current = channel.port1;
        // '*' because the frame's origin is opaque and no other value can name it. Only the first load
        // reaches this line, when the frame still holds the document it was given.
        frame.contentWindow?.postMessage(APP_CONNECT_MESSAGE, '*', [channel.port2]);
        tell({ event: 'colorScheme', colorScheme });
    };

    const reopen = () => {
        loads.current = 0;
        setLeft(false);
        setAttempt(current => current + 1);
    };

    if (left) {
        return (
            <Alert color="red" title={`${name} tried to leave its page`}>
                It was closed, because an app that navigates away is no longer running inside its restrictions.
                <Box mt="sm">
                    <Button size="xs" variant="default" onClick={reopen}>
                        Open it again
                    </Button>
                </Box>
            </Alert>
        );
    }

    return (
        <iframe
            key={attempt}
            title={name}
            sandbox={APP_SANDBOX}
            srcDoc={appDocument(html, { project, grants, colorScheme: firstColorScheme })}
            referrerPolicy="no-referrer"
            onLoad={event => onLoad(event.currentTarget)}
            style={{ flex: 1, width: '100%', minHeight: 0, border: 0, colorScheme }}
        />
    );
}
