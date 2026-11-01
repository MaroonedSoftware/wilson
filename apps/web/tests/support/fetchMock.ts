import type { Mock } from 'vitest';

/** A stubbed global `fetch`, typed as the SDK calls it: always a string URL and a `RequestInit`. */
export type FetchMock = Mock<(url: string, init: RequestInit) => Promise<Response>>;
