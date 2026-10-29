import type { CreateHostRequest, Host, PutHostProjectRequest, UpdateHostRequest } from './types/hosts.js';
import { reviveHost } from './types/hosts.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson } from './sdk-options.js';

/**
 * generated from [hosts.ck](../../../apps/api/data/contracts/hosts.ck)
 */
export class HostsClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List hosts */
    async listHosts(): Promise<Host[]> {
        const result = await this.fetch(`/api/hosts`, { method: 'GET' });
        return (await parseJson<Host[]>(result)).map(reviveHost);
    }

    /** @name Register host */
    async registerHost(body: CreateHostRequest): Promise<Host> {
        const result = await this.fetch(`/api/hosts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveHost(await parseJson<Host>(result));
    }

    /** @name Get host */
    async getHost(name: string): Promise<Host> {
        const result = await this.fetch(`/api/hosts/${encodeURIComponent(name)}`, { method: 'GET' });
        return reviveHost(await parseJson<Host>(result));
    }

    /** @name Update host */
    async updateHost(name: string, body: UpdateHostRequest): Promise<Host> {
        const result = await this.fetch(`/api/hosts/${encodeURIComponent(name)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveHost(await parseJson<Host>(result));
    }

    /** @name Remove host */
    async removeHost(name: string): Promise<void> {
        await this.fetch(`/api/hosts/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }

    /**
     * @name Probe host
     * @description Connect to the host and record what is there: that SSH reaches it, which `claude` it has, that each
     * project's clone is a git repository and its roots can be written, and, given a lifetime, when it
     * will stop. A failed check is a recorded result (`probe.ok: false`), not an error response.
     */
    async probeHost(name: string): Promise<Host> {
        const result = await this.fetch(`/api/hosts/${encodeURIComponent(name)}/probe`, { method: 'POST' });
        return reviveHost(await parseJson<Host>(result));
    }

    /**
     * @name Set host project
     * @description `put`, not `patch`: a project on a host is its three paths together, and a half-set one would
     * cut worktrees from a clone that is not there.
     */
    async setHostProject(name: string, project: string, body: PutHostProjectRequest): Promise<Host> {
        const result = await this.fetch(`/api/hosts/${encodeURIComponent(name)}/projects/${encodeURIComponent(project)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveHost(await parseJson<Host>(result));
    }

    /**
     * @name Remove host project
     * @description `put`, not `patch`: a project on a host is its three paths together, and a half-set one would
     * cut worktrees from a clone that is not there.
     */
    async removeHostProject(name: string, project: string): Promise<void> {
        await this.fetch(`/api/hosts/${encodeURIComponent(name)}/projects/${encodeURIComponent(project)}`, { method: 'DELETE' });
    }
}
