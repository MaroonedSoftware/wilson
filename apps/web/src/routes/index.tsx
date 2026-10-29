import { createFileRoute } from '@tanstack/react-router';
import { ChatView } from '#src/components/ChatView.js';

/**
 * `/`: the chat, the whole page, as ats's home page is (`ChatHomePage`): ask about the board or tell
 * it what to do, and the screens are a click away. The projects list it replaced is at `/projects`.
 * The root layout gives this route the full height and no padding (`__root.tsx`).
 */
function ChatHomeRoute() {
    return <ChatView variant="page" />;
}

export const Route = createFileRoute('/')({ component: ChatHomeRoute });
