export class SdkError<TBody = unknown> extends Error {
    constructor(
        public readonly status: number,
        public readonly statusText: string,
        public readonly body: TBody,
        public readonly headers: Headers,
    ) {
        super(`${status} ${statusText}`);
        this.name = 'SdkError';
    }
}

export interface SdkRequestInit extends RequestInit {
    /**
     * Statuses this operation declares as values rather than errors — a 304 from
     * conditional-GET middleware, or an error status the service returns deliberately.
     * Anything else at or above 400 still throws SdkError.
     */
    expectStatuses?: number[];
}

export type SdkFetch = (url: string, init: SdkRequestInit) => Promise<Response>;

export interface SdkOptions {
    baseUrl: string;
    headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
    fetch?: SdkFetch;
    /** Called once per request to produce a unique X-Request-ID header value */
    requestIdFactory?: () => string;
    /**
     * Card 0150. The project this client targets, sent as `X-Wilson-Project` on every call — the
     * header `apps/api/src/routes/routes.setup.ts`'s `ProjectContextRouter` reads to run the request
     * against that project's board instead of the daemon's own configured one. Unset (the default)
     * means the header is absent, which the server reads as its own configured project — exactly
     * what every client built before this card already gets, unchanged.
     */
    project?: string;
}

export const bigIntReplacer = (_: string, value: any): any => {
    if (typeof value === 'bigint') {
        return value.toString() + 'n';
    }
    return value;
};

export const bigIntReviver = (_: string, value: any): any => {
    if (typeof value === 'string' && /^-?\d+n$/.test(value)) {
        return BigInt(value.slice(0, -1));
    }
    return value;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function readContentType(res: Response): string {
    return res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
}

export function createSdkFetch(options: SdkOptions): SdkFetch {
    const getRequestId = options.requestIdFactory ?? (() => crypto.randomUUID());
    return async (url: string, init: SdkRequestInit): Promise<Response> => {
        const baseHeaders = typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {});
        const headers: Record<string, string> = { ...baseHeaders, 'X-Request-ID': getRequestId(), ...(init.headers as Record<string, string>) };
        // Card 0150: set as a plain assignment, not spread into the object literal above — a
        // conditional object literal (`options.project ? {...} : {}`) spread into a union-shaped
        // headers object trips TypeScript's excess-property check against `HeadersInit`. Omitted
        // entirely when `project` is unset, rather than sent empty: the server treats an absent
        // header and an empty one the same way, but omitting it is what keeps a request from an SDK
        // built before this card byte-identical to one built after.
        if (options.project) headers['X-Wilson-Project'] = options.project;
        const res = await fetch(`${options.baseUrl}${url}`, { ...init, headers });
        if (!res.ok && !(init.expectStatuses ?? []).includes(res.status)) {
            const text = await res.text();
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
            throw new SdkError(res.status, res.statusText, body, res.headers);
        }
        return res;
    };
}

export function buildQueryString(query: object | undefined): string {
    const searchParams = new URLSearchParams();
    if (query) {
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null) continue;
            if (Array.isArray(v)) {
                for (const item of v) searchParams.append(k, String(item));
            } else searchParams.set(k, String(v));
        }
    }
    const qs = searchParams.toString();
    return qs ? `?${qs}` : '';
}

export async function parseJson<T>(res: Response): Promise<T> {
    return JSON.parse(await res.text(), bigIntReviver) as T;
}
