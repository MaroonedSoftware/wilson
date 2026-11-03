import { useState } from 'react';
import { Badge, Button, Card, Checkbox, Group, Radio, Stack, Text, TextInput } from '@mantine/core';
import { IconQuestionMark } from '@tabler/icons-react';
import type { ChatPendingQuestion, ChatQuestion, ChatQuestionAnswer } from '@wilson/sdk';
import { useAnswerChatQuestions } from '#src/lib/chat.js';
import { reasonFor } from '#src/lib/mutations.js';

const STATUS_COLOR: Record<ChatPendingQuestion['status'], string> = { pending: 'yellow', answered: 'green', dismissed: 'gray' };

/** Whether a question still waits on the person: past its expiry the server would refuse an answer. */
export const isUnanswered = (question: ChatPendingQuestion): boolean => question.status === 'pending' && question.expiresAt.toMillis() > Date.now();

// The source of truth is `MAX_OTHER_LENGTH` in `apps/api/src/modules/chat/chat.questions.ts`; `apps/web`
// cannot import from `apps/api`, so this is kept as its own constant rather than a shared package.
const MAX_OTHER_LENGTH = 500;

/** Replaces the entry at `index` in an array of per-question state, leaving the rest as they were. */
const replaceAt =
    <T,>(index: number, value: T) =>
    (previous: T[]): T[] =>
        previous.map((entry, i) => (i === index ? value : entry));

/** The given answer as it reads in the conversation: the chosen labels, then any "Other" text, joined. */
const answerText = (q: ChatQuestion, given: ChatQuestionAnswer | undefined): string | undefined => {
    if (!given) return undefined;
    const labels = given.chosen.map(index => q.options[index]?.label).filter((label): label is string => Boolean(label));
    const parts = [...labels, ...(given.other ? [given.other] : [])];
    return parts.length > 0 ? parts.join(', ') : undefined;
};

/**
 * A question the chat asked, answered here with a click: its 1-4 prompts rendered as radio or
 * checkbox groups plus an "Other" box, one Submit for all of it. Past its expiry, or once dismissed
 * by an ordinary message on the thread, it says so rather than offering a button the server would
 * refuse. Once answered it keeps the choices — and any "Other" text — in the conversation, with no
 * controls.
 */
export function ChatQuestionCard({ question }: { question: ChatPendingQuestion }) {
    const answer = useAnswerChatQuestions(question.threadId);
    const unanswered = isUnanswered(question);
    const expired = question.status === 'pending' && !unanswered;

    const [chosen, setChosen] = useState<string[][]>(() => question.questions.map(() => []));
    const [other, setOther] = useState<string[]>(() => question.questions.map(() => ''));

    const complete = question.questions.every((_, i) => chosen[i]!.length > 0 || other[i]!.trim() !== '');

    const submit = () => {
        const answers: ChatQuestionAnswer[] = question.questions.map((_, i) => {
            const said = other[i]!.trim();
            return {
                chosen: chosen[i]!.map(Number).sort((a, b) => a - b),
                ...(said ? { other: said } : {}),
            };
        });
        answer.mutate({ questionId: question.id, answers });
    };

    return (
        <Card withBorder padding="md" radius="md" role="group" aria-label="Question">
            <Stack gap="sm">
                <Group gap="xs" wrap="nowrap" align="flex-start" justify="space-between">
                    <Group gap="xs" wrap="nowrap" align="flex-start">
                        {unanswered && (
                            <IconQuestionMark size={18} color="var(--mantine-color-yellow-6)" aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                        )}
                        {unanswered && (
                            <Text size="xs" c="dimmed">
                                Expires {question.expiresAt.toRelative()}.
                            </Text>
                        )}
                    </Group>
                    {!unanswered && (
                        <Badge size="xs" color={expired ? 'gray' : STATUS_COLOR[question.status]} variant="light" style={{ flexShrink: 0 }}>
                            {expired ? 'expired' : question.status}
                        </Badge>
                    )}
                </Group>
                {unanswered
                    ? question.questions.map((q, i) => (
                          <Stack key={i} gap="xs">
                              {q.multiSelect ? (
                                  <Checkbox.Group
                                      label={q.header}
                                      description={q.text}
                                      value={chosen[i]}
                                      onChange={value => setChosen(replaceAt(i, value))}
                                  >
                                      <Stack gap="xs" mt="xs">
                                          {q.options.map((option, index) => (
                                              <Checkbox
                                                  key={index}
                                                  value={String(index)}
                                                  label={option.label}
                                                  description={option.description}
                                                  disabled={answer.isPending}
                                              />
                                          ))}
                                      </Stack>
                                  </Checkbox.Group>
                              ) : (
                                  <Radio.Group
                                      label={q.header}
                                      description={q.text}
                                      value={chosen[i]![0] ?? null}
                                      onChange={value => {
                                          setChosen(replaceAt(i, [value]));
                                          setOther(replaceAt(i, ''));
                                      }}
                                  >
                                      <Stack gap="xs" mt="xs">
                                          {q.options.map((option, index) => (
                                              <Radio
                                                  key={index}
                                                  value={String(index)}
                                                  label={option.label}
                                                  description={option.description}
                                                  disabled={answer.isPending}
                                              />
                                          ))}
                                      </Stack>
                                  </Radio.Group>
                              )}
                              <TextInput
                                  label="Other"
                                  placeholder="Something else…"
                                  maxLength={MAX_OTHER_LENGTH}
                                  value={other[i]}
                                  onChange={event => {
                                      const typed = event.currentTarget.value;
                                      setOther(replaceAt(i, typed));
                                      // A single choice is one answer: typing an "Other" replaces the option, since a radio cannot be unticked.
                                      if (!q.multiSelect && typed.trim() !== '') setChosen(replaceAt<string[]>(i, []));
                                  }}
                                  disabled={answer.isPending}
                              />
                          </Stack>
                      ))
                    : question.questions.map((q, i) => {
                          const given = answerText(q, question.answers?.[i]);
                          return (
                              <Stack key={i} gap={2}>
                                  <Text size="sm" fw={500}>
                                      {q.header}
                                  </Text>
                                  <Text size="xs" c="dimmed">
                                      {q.text}
                                  </Text>
                                  {given && <Text size="sm">{given}</Text>}
                              </Stack>
                          );
                      })}
                {unanswered && (
                    <Group gap="xs" justify="flex-end">
                        <Button size="xs" loading={answer.isPending} disabled={!complete} onClick={submit}>
                            Submit
                        </Button>
                    </Group>
                )}
                {answer.isError && (
                    <Text size="xs" c="red">
                        {reasonFor(answer.error)}
                    </Text>
                )}
            </Stack>
        </Card>
    );
}
