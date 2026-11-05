import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button } from '@mantine/core';
import type { AppGrant } from '@wilson/sdk';
import { serveApp } from '#src/lib/app.broker.js';
import { APP_CONNECT_MESSAGE, appDocument, APP_SANDBOX } from '#src/lib/apps.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

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
 */
export function AppFrame({ name, html, project, grants }: { name: string; html: string; project: string; grants: readonly AppGrant[] }) {
    const client = useWilsonSdk();
    const loads = useRef(0);
    const port = useRef<MessagePort | undefined>(undefined);
    const [left, setLeft] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => () => port.current?.close(), []);

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
            srcDoc={appDocument(html, { project, grants })}
            referrerPolicy="no-referrer"
            onLoad={event => onLoad(event.currentTarget)}
            style={{ flex: 1, width: '100%', minHeight: 0, border: 0, background: 'white' }}
        />
    );
}
