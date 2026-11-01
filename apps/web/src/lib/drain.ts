import { useQuery } from '@tanstack/react-query';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

export const DRAIN_QUERY_KEY = ['settings', 'drain'];

/** Often while draining, because that is when someone is waiting for `safeToRestart`. */
const DRAINING_REFETCH_MS = 5_000;
const IDLE_REFETCH_MS = 60_000;

/** The server's drain status, shared by the Settings control and the header indicator. */
export const useDrainStatus = () => {
    const wilson = useWilsonSdk();
    return useQuery({
        queryKey: DRAIN_QUERY_KEY,
        queryFn: () => wilson.settings.getDrainStatus(),
        refetchInterval: query => (query.state.data?.draining ? DRAINING_REFETCH_MS : IDLE_REFETCH_MS),
    });
};
