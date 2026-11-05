import { useRef, useState } from 'react';
import { Alert, Box, Button } from '@mantine/core';
import { appDocument, APP_SANDBOX } from '#src/lib/apps.js';

/**
 * One operator app, running in a sandboxed iframe. The sandbox gives it an opaque origin, so it can
 * reach none of this page's cookies, storage or DOM, and `appDocument`'s policy refuses its requests.
 *
 * That policy lives in the document, so it cannot stop the frame navigating itself somewhere else,
 * and neither can the sandbox. The page's own `frame-src 'none'` header does (`deploy/web.nginx.conf`,
 * `vite.config.ts`), and the attempt still fires a load. An app has one document for its whole life, so
 * a second load means it tried, and the frame is taken away.
 */
export function AppFrame({ name, html }: { name: string; html: string }) {
    const loads = useRef(0);
    const [left, setLeft] = useState(false);
    const [attempt, setAttempt] = useState(0);

    const onLoad = () => {
        loads.current += 1;
        if (loads.current > 1) setLeft(true);
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
            srcDoc={appDocument(html)}
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            style={{ flex: 1, width: '100%', minHeight: 0, border: 0, background: 'white' }}
        />
    );
}
