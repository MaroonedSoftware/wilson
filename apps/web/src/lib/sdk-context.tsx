import { createContext, useContext, type ReactNode } from 'react';
import type { WilsonSdk } from '@wilson/sdk';

/**
 * Card 0156. The client a component's queries and mutations go through, supplied by whichever route
 * rendered it — `wilson` under a top-level route, `wilsonForProject(project)` under a
 * `/projects/$project/*` one (`lib/sdk.js`).
 *
 * A provider + hook, not a prop: a client threaded as a prop would have to be re-declared on every
 * intermediate component between the route and whatever actually calls the SDK — `CardDetailView`
 * passing it to `PlanningPanes` passing it to `PlanningSessionPane`, and so on for every screen — the
 * exact per-site propagation this split exists to avoid. A route wraps its own render tree in
 * `WilsonSdkProvider` once; any component under it reaches the client with `useWilsonSdk()`,
 * regardless of how deep it sits.
 *
 * No default value: a component rendered with no provider above it must fail loudly, not fall back
 * to the unscoped `wilson` singleton. A silent fallback would make a component rendered under a
 * project-scoped route that forgot to wrap it talk to the wrong project without any error at all —
 * exactly the failure card 0150 already refuses at the API, one layer up.
 */
const WilsonSdkContext = createContext<WilsonSdk | undefined>(undefined);

/** Establishes `client` as what `useWilsonSdk()` returns for everything under `children`. */
export function WilsonSdkProvider({ client, children }: { client: WilsonSdk; children: ReactNode }) {
    return <WilsonSdkContext.Provider value={client}>{children}</WilsonSdkContext.Provider>;
}

/** The client supplied by the nearest `WilsonSdkProvider` above this component. Throws if there is none. */
export function useWilsonSdk(): WilsonSdk {
    const client = useContext(WilsonSdkContext);
    if (!client) {
        throw new Error('useWilsonSdk() called with no WilsonSdkProvider above it in the tree.');
    }
    return client;
}
