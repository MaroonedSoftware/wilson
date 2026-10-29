import { isAbsolute, posix } from 'node:path';
import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { ProjectRepository } from '#modules/board/project.repository.js';
import type { CreateHostRequest, Host, PutHostProjectRequest, UpdateHostRequest } from '../../generated/hosts.js';
import { HostRepository, type HostPatch, type HostRow } from './host.repository.js';

/** The range `runner.hosts.slots` allows, checked here so a caller gets a 400 rather than a 500. */
const MIN_SLOTS = 1;
const MAX_SLOTS = 8;

/**
 * The host registry behind `/api/hosts` (`hosts.ck`): registering a machine a stage can run on,
 * switching it on and off, and saying which projects it serves and where each one's clone is.
 *
 * Nothing here reaches the host. A path is checked for being absolute and nothing else, the restraint
 * `ProjectsService` already shows: whether the clone is really there is found out by probing, not by
 * a check guessing at what "working" means.
 */
@Injectable()
export class HostsService {
    constructor(
        private readonly hosts: HostRepository,
        private readonly projects: ProjectRepository,
    ) {}

    async list(): Promise<Host[]> {
        return (await this.hosts.list()).map(toHost);
    }

    async get(name: string): Promise<Host> {
        return toHost(await this.require(name));
    }

    /** Register a host. Refuses a taken name with 409, and a bad name, target or slot count with 400. */
    async create(request: CreateHostRequest): Promise<Host> {
        const name = requireNonEmpty('name', request.name);
        const sshTarget = request.sshTarget === undefined ? name : requireNonEmpty('sshTarget', request.sshTarget);
        const slots = request.slots === undefined ? MIN_SLOTS : requireSlots(request.slots);
        const lifetimeMinutes = request.lifetimeMinutes === undefined ? undefined : requireLifetime(request.lifetimeMinutes);
        const commandEnv = request.commandEnv === undefined ? undefined : requireVariableNames(request.commandEnv);

        if (await this.hosts.find(name)) {
            throw httpError(409).withDetails({ reason: `host "${name}" is already registered` });
        }

        await this.hosts.create({ name, sshTarget, slots, ...(lifetimeMinutes && { lifetimeMinutes }), ...(commandEnv && { commandEnv }) });
        return this.get(name);
    }

    /** Change a host's target, slots or switches. Refuses an unregistered name with 404. */
    async update(name: string, request: UpdateHostRequest): Promise<Host> {
        const patch: HostPatch = {};
        if (request.sshTarget !== undefined) patch.sshTarget = requireNonEmpty('sshTarget', request.sshTarget);
        if (request.slots !== undefined) patch.slots = requireSlots(request.slots);
        if (request.enabled !== undefined) patch.enabled = request.enabled;
        if (request.draining !== undefined) patch.draining = request.draining;
        // 0 clears it: the contract's way of saying "no known end" without a null on the wire.
        if (request.commandEnv !== undefined) patch.commandEnv = requireVariableNames(request.commandEnv);
        if (request.lifetimeMinutes !== undefined)
            patch.lifetimeMinutes = request.lifetimeMinutes === 0 ? null : requireLifetime(request.lifetimeMinutes);

        if (!(await this.hosts.update(name, patch))) {
            throw notFound(name);
        }
        return this.get(name);
    }

    async remove(name: string): Promise<void> {
        if (!(await this.hosts.remove(name))) {
            throw notFound(name);
        }
    }

    /**
     * Say where `project` lives on host `name`. Refuses an unknown host or an unregistered project
     * with 404, and any path that is not absolute with 400. The paths are the host's, so they are
     * normalised as POSIX paths whatever this machine is.
     */
    async putProject(name: string, project: string, request: PutHostProjectRequest): Promise<Host> {
        await this.require(name);
        if (!(await this.projects.find(project))) {
            throw httpError(404).withDetails({ reason: `project "${project}" is not registered` });
        }

        await this.hosts.putProject(name, {
            project,
            codeRoot: requireAbsolutePath('codeRoot', request.codeRoot),
            worktreeRoot: requireAbsolutePath('worktreeRoot', request.worktreeRoot),
            runRoot: requireAbsolutePath('runRoot', request.runRoot),
        });
        return this.get(name);
    }

    async removeProject(name: string, project: string): Promise<void> {
        await this.require(name);
        if (!(await this.hosts.removeProject(name, project))) {
            throw httpError(404).withDetails({ reason: `host "${name}" does not serve project "${project}"` });
        }
    }

    private async require(name: string): Promise<HostRow> {
        const host = await this.hosts.find(name);
        if (!host) throw notFound(name);
        return host;
    }
}

/** A row as the API returns it. */
export const toHost = (row: HostRow): Host => ({
    name: row.name,
    sshTarget: row.sshTarget,
    slots: row.slots,
    enabled: row.enabled,
    draining: row.draining,
    ...(row.lifetimeMinutes !== undefined && { lifetimeMinutes: row.lifetimeMinutes }),
    commandEnv: row.commandEnv,
    projects: row.projects,
    running: row.running,
    ...(row.probe && { probe: row.probe }),
});

const notFound = (name: string) => httpError(404).withDetails({ reason: `host "${name}" is not registered` });

const requireNonEmpty = (field: string, value: string): string => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw httpError(400).withDetails({ reason: `${field} must not be empty` });
    }
    return trimmed;
};

const requireSlots = (value: number): number => {
    if (!Number.isInteger(value) || value < MIN_SLOTS || value > MAX_SLOTS) {
        throw httpError(400).withDetails({ reason: `slots must be a whole number from ${MIN_SLOTS} to ${MAX_SLOTS}, got ${value}` });
    }
    return value;
};

/**
 * Names a shell can expand, deduplicated in the order given. Checked because each one is spliced into
 * a remote command line as `NAME="${NAME-}"` (`SshHost`); a name with anything else in it would not
 * be a name to that shell.
 */
const requireVariableNames = (names: string[]): string[] => {
    const bad = names.filter(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
    if (bad.length > 0) {
        throw httpError(400).withDetails({ reason: `commandEnv names must be environment variable names, got ${bad.map(n => `"${n}"`).join(', ')}` });
    }
    return [...new Set(names)];
};

const requireLifetime = (value: number): number => {
    if (!Number.isInteger(value) || value < 1) {
        throw httpError(400).withDetails({ reason: `lifetimeMinutes must be a whole number of minutes above 0, got ${value}` });
    }
    return value;
};

const requireAbsolutePath = (field: string, value: string): string => {
    if (!isAbsolute(value) || !value.startsWith('/')) {
        throw httpError(400).withDetails({ reason: `${field} must be an absolute path on the host, got "${value}"` });
    }
    return posix.resolve(value);
};
