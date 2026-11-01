import { Alert, Loader, Stack, Switch, Text } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage } from '#src/lib/api.error.js';
import { DRAIN_QUERY_KEY, useDrainStatus } from '#src/lib/drain.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

/**
 * Turns a drain on and off, and says what a restart would still interrupt. Renders what the server
 * hands back rather than the value clicked, the same rule `AutoModeToggle` follows.
 */
export function DrainControl() {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const status = useDrainStatus();
    const mutation = useMutation({
        mutationFn: (draining: boolean) => wilson.settings.setDrain({ draining }),
        onSuccess: result => queryClient.setQueryData(DRAIN_QUERY_KEY, result),
    });

    if (status.error) {
        return (
            <Alert color="red" title="Cannot load drain status">
                {apiErrorMessage(status.error)}
            </Alert>
        );
    }
    if (!status.data) return <Loader size="sm" />;

    const { draining, running, held, planDrafts, safeToRestart } = status.data;

    return (
        <Stack gap="xs">
            <Switch
                label="Drain"
                description="Lets running stages finish and starts nothing new, across every project. Stays on through a restart until turned off."
                checked={draining}
                disabled={mutation.isPending}
                onChange={event => mutation.mutate(event.currentTarget.checked)}
            />
            {draining && (
                <Text size="sm" c={safeToRestart ? 'green' : 'dimmed'}>
                    {safeToRestart ? 'Safe to restart.' : 'Not safe to restart yet.'} {running.length} running
                    {running.length > 0 && ` (${running.map(card => `${card.project}/${card.cardId}`).join(', ')})`}, {held} held, {planDrafts} plan
                    drafts.
                </Text>
            )}
            {mutation.isError && (
                <Text size="sm" c="red">
                    {apiErrorMessage(mutation.error)}
                </Text>
            )}
        </Stack>
    );
}
