import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActionIcon, Alert, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core';
import { IconScissors, IconSend, IconSparkles } from '@tabler/icons-react';
import type { CardDetail, PlanTurn, PlanTurnRequest } from '@wilson/sdk';
import { ConversationView } from '#src/components/ConversationPane.js';
import { reasonFor } from '#src/lib/mutations.js';
import { usePlanTranscript, useSendPlanTurn } from '#src/lib/plan.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

/**
 * The textarea, send control and — card 0240 — the "Propose cuts" control that sends the same
 * textarea contents as a `mode: 'cuts'` turn instead of an ordinary one. Both are disabled while a
 * turn is already in flight or the session has not finished opening. A refusal shows the server's
 * own sentence beneath the controls (`reasonFor`, `mutations.ts`) rather than a generic message, and
 * leaves the typed text in place so it can be edited and resent instead of retyped.
 *
 * Ordinary send stays gated on non-empty text, exactly as before; "Propose cuts" is not — this
 * card's Constraints send `[propose cuts]` for an empty box (`PlanService.appendTurn`), so the
 * button asking for that has nothing to require the box hold first.
 *
 * "Draft the plan" is the same again with `mode: 'draft'`: the agent fills in the whole draft with
 * nothing typed, and anything that is typed goes along as guidance. It is the filled button only
 * while the conversation is empty, because that is the moment it is the obvious next step.
 */
function Composer({
    sendTurn,
    disabled,
    noTurnsYet,
    onSent,
}: {
    sendTurn: ReturnType<typeof useSendPlanTurn>;
    disabled: boolean;
    noTurnsYet: boolean;
    onSent: (turn: PlanTurn) => void;
}) {
    const [text, setText] = useState('');

    const sendRequest = (request: PlanTurnRequest) => {
        if (sendTurn.isPending) return;
        sendTurn.mutate(request, {
            onSuccess: turn => {
                setText('');
                onSent(turn);
            },
        });
    };

    const send = () => {
        const trimmed = text.trim();
        if (!trimmed) return;
        sendRequest({ text: trimmed });
    };

    const proposeCuts = () => sendRequest({ text: text.trim(), mode: 'cuts' });
    const draftThePlan = () => sendRequest({ text: text.trim(), mode: 'draft' });

    return (
        <Paper withBorder p="xs" radius="sm">
            <Stack gap={6}>
                <Group gap={6} align="flex-end" wrap="nowrap">
                    <Textarea
                        aria-label="Message"
                        placeholder="Talk through the plan…"
                        autosize
                        minRows={1}
                        maxRows={8}
                        style={{ flex: 1 }}
                        value={text}
                        disabled={disabled || sendTurn.isPending}
                        onChange={event => setText(event.currentTarget.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                send();
                            }
                        }}
                    />
                    <ActionIcon
                        size="lg"
                        variant="filled"
                        aria-label="Send"
                        disabled={disabled || sendTurn.isPending || text.trim().length === 0}
                        loading={sendTurn.isPending}
                        onClick={send}
                    >
                        <IconSend size={16} />
                    </ActionIcon>
                </Group>
                <Group gap={6}>
                    <Button
                        size="xs"
                        variant={noTurnsYet ? 'filled' : 'light'}
                        leftSection={<IconSparkles size={14} />}
                        disabled={disabled || sendTurn.isPending}
                        loading={sendTurn.isPending}
                        onClick={draftThePlan}
                    >
                        Draft the plan
                    </Button>
                    <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconScissors size={14} />}
                        disabled={disabled || sendTurn.isPending}
                        loading={sendTurn.isPending}
                        onClick={proposeCuts}
                    >
                        Propose cuts
                    </Button>
                </Group>
                {sendTurn.isError && (
                    <Text size="xs" c="red">
                        {reasonFor(sendTurn.error)}
                    </Text>
                )}
            </Stack>
        </Paper>
    );
}

/**
 * The conversation half of card 0121's two-pane `planning` view — the draft pane beside it is
 * [[0138]]. Opens (or rejoins — deterministic per card, card 0058) the session on mount, streams
 * the transcript through `usePlanTranscript` (`lib/plan.ts`), and renders the composer beneath it.
 *
 * `openAPlanningSession` is called here rather than left to the first turn's own lazy cut
 * (`PlanService.appendTurn`'s `isFirstTurn` branch) so the two guards it shares with `turn` — a
 * card outside `planning`, or one whose real branch already has work — surface as soon as the pane
 * mounts, as an inline `Alert`, instead of only once an operator has typed a first message. The
 * composer stays disabled until it succeeds.
 *
 * The transcript itself is never rebuilt by hand from what this component has seen: `turns` and
 * `pendingText` come straight from `usePlanTranscript`, and the one thing added here —
 * `sendTurn.variables` while a send is in flight — is the literal text just submitted, not a guess
 * folded in from the stream.
 *
 * `project`, card 0153: threaded straight through to `usePlanTranscript` so the stream names it too —
 * `openAPlanningSession`/`useSendPlanTurn` below still call the singleton `wilson` client regardless,
 * the propagation this card's plan defers to [[0155]].
 *
 * Card 0156: `openAPlanningSession` reads its client through `useWilsonSdk()` rather than importing
 * the singleton directly, so a card reached through a `/projects/$project/*` route opens its planning
 * session against that project's client, same as every other read on this pane.
 */
export function PlanningSessionPane({ card, project }: { card: CardDetail; project?: string }) {
    const wilson = useWilsonSdk();
    const session = useQuery({ queryKey: ['plan-session', card.id], queryFn: () => wilson.board.openAPlanningSession(card.id) });
    const transcript = usePlanTranscript(card.id, true, project);
    const sendTurn = useSendPlanTurn(card.id);

    const outgoingText = sendTurn.isPending ? sendTurn.variables?.text : undefined;

    return (
        <Stack gap="xs" h="100%">
            {transcript.error && (
                <Alert color="red" title="Stream disconnected">
                    {transcript.error}
                </Alert>
            )}
            {session.error && (
                <Alert color="red" title="Could not open the planning session">
                    {reasonFor(session.error)}
                </Alert>
            )}
            <ConversationView
                turns={transcript.turns}
                outgoingText={outgoingText}
                pendingText={transcript.pendingText}
                emptyText="No turns yet — start the conversation below."
            />
            <Composer sendTurn={sendTurn} disabled={!session.data} noTurnsYet={transcript.turns.length === 0} onSent={transcript.commitTurn} />
        </Stack>
    );
}
