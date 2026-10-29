import type { CliContext } from '@maroonedsoftware/johnny5';
import { keyringEntry, type KeyringEntry } from '@maroonedsoftware/johnny5/keyring';
import { setting } from './settings.js';

/** The API key `wilson auth login` minted for this machine, as it is kept in the keyring. */
export interface StoredKey {
    /** The `wl_...` token sent as `Authorization: Bearer`. */
    token: string;
    /** Its id on the server, so `wilson auth logout` can revoke it. */
    id: string;
    name: string;
}

/** The keyring slot for the key that talks to the API at `baseUrl`: one per API, so a local and a
 * remote wilson never overwrite each other. */
export const keyAccount = (baseUrl: string): string => `apikey:${new URL(baseUrl).origin}`;

/**
 * Where the CLI's credential lives: the OS keyring (macOS Keychain, Secret Service, Windows
 * Credential Manager), never a file, as ats keeps its CLI session. `entry` is injectable so tests
 * never touch the developer's own keychain.
 */
export const keyStore = (entry: KeyringEntry) => ({
    async read(): Promise<StoredKey | undefined> {
        const raw = await entry.read();
        if (raw === null) return undefined;
        try {
            const parsed = JSON.parse(raw) as StoredKey;
            return typeof parsed.token === 'string' && typeof parsed.id === 'string' ? parsed : undefined;
        } catch {
            // Unreadable reads as signed out; signing in again replaces it.
            return undefined;
        }
    },
    write: (key: StoredKey): Promise<boolean> => entry.write(JSON.stringify({ token: key.token, id: key.id, name: key.name } satisfies StoredKey)),
    clear: (): Promise<boolean> => entry.delete(),
});

export type KeyStore = ReturnType<typeof keyStore>;

export const keyStoreFor = (ctx: CliContext, baseUrl: string): KeyStore =>
    keyStore(keyringEntry(ctx, { service: 'wilson', account: keyAccount(baseUrl) }));

/**
 * The bearer token for a request, if there is one: `WILSON_API_KEY` when set (for scripts, CI, and a
 * machine with no keyring), otherwise the key `wilson auth login` stored.
 */
export const resolveToken = async (ctx: CliContext, store: KeyStore): Promise<string | undefined> => {
    const fromEnv = setting(ctx, 'WILSON_API_KEY', '');
    if (fromEnv) return fromEnv;
    return (await store.read())?.token;
};
