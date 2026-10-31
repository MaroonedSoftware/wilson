import type { CreateHostRequest, Host, IssuedWorkerToken, PutHostProjectRequest, UpdateHostRequest } from './types/hosts.js';
import { reviveHost, reviveIssuedWorkerToken } from './types/hosts.js';
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

    /**
     * @name Register host
     * @description Register a machine card stages can run on, reached over SSH or by a worker program that connects
     * in. A worker host then needs its token minted with `wilson host token` or on the web app's Hosts
     * page, which agents cannot do, and the worker started on the machine (`apps/worker/README.md`).
     */
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
     * @description Connect to the host and record what is there: that it can be reached, which `claude` it has, that each
     * project's clone is a git repository and its roots can be written, and, given a lifetime, when it
     * will stop. A failed check is a recorded result (`probe.ok: false`), not an error response.
     */
    async probeHost(name: string): Promise<Host> {
        const result = await this.fetch(`/api/hosts/${encodeURIComponent(name)}/probe`, { method: 'POST' });
        return reviveHost(await parseJson<Host>(result));
    }

    /**
     * @name Set host project
     * @description Say where a project lives on a host, which lets stages for it run there. Not needed for a
     * project a worker host's `projectsRoot` takes on by itself.
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
     * @description Stop serving a project from a host. Files already on the machine are left there.
     */
    async removeHostProject(name: string, project: string): Promise<void> {
        await this.fetch(`/api/hosts/${encodeURIComponent(name)}/projects/${encodeURIComponent(project)}`, { method: 'DELETE' });
    }

    /**
     * @name Mint worker token
     * @description The one credential a worker host's worker program connects with. Only the worker endpoint accepts
     * it, and only as this host, so it grants less than the `manage` key or session minting it already
     * holds; that is why minting needs `wilson.manage` and not a step-up, which a CLI key cannot give.
     * `post` mints one, replacing any the host had, so rotating is posting again.
     */
    async mintWorkerToken(name: string): Promise<IssuedWorkerToken> {
        const result = await this.fetch(`/api/hosts/${encodeURIComponent(name)}/worker-token`, { method: 'POST' });
        return reviveIssuedWorkerToken(await parseJson<IssuedWorkerToken>(result));
    }

    /**
     * @name Revoke worker token
     * @description The one credential a worker host's worker program connects with. Only the worker endpoint accepts
     * it, and only as this host, so it grants less than the `manage` key or session minting it already
     * holds; that is why minting needs `wilson.manage` and not a step-up, which a CLI key cannot give.
     * `post` mints one, replacing any the host had, so rotating is posting again.
     */
    async revokeWorkerToken(name: string): Promise<void> {
        await this.fetch(`/api/hosts/${encodeURIComponent(name)}/worker-token`, { method: 'DELETE' });
    }
}
