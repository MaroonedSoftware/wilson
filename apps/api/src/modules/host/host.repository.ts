import { Injectable } from 'injectkit';
// A value import, not `import type`: `@Injectable()`'s `design:paramtypes` metadata has to name
// `Kysely` as a value, the reason `ProjectRepository` gives for the same line.
import { Kysely } from 'kysely';
import type { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';
import { hostSlotKey } from './placement.js';

/** What every slot key on `hostName` starts with: `hostSlotKey` with the slot number left off. */
const slotPrefix = (hostName: string): string => hostSlotKey(hostName, 0).slice(0, -1);

/** Where one project lives on a host: its clone, and the roots worktrees and plans go under. */
export interface HostProjectRow {
    project: string;
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
}

/** A slot on a host held by a stage, from its `wilson.leases` row. */
export interface HostSlotUseRow {
    slot: number;
    project: string;
    cardId: string;
    since: DateTime;
}

/** A host slot's `wilson.leases` row, before it is matched to a host. */
type SlotLease = { resourceKey: string; project: string; cardId: string; acquiredAt: DateTime };

/** What the last probe of a host found. */
export interface HostProbeRow {
    probedAt: DateTime;
    ok: boolean;
    detail?: string;
    engineVersion?: string;
    expiresAt?: DateTime;
}

/**
 * How the daemon reaches a host: `ssh` connects out to `sshTarget`; `worker` waits for the worker
 * program on the machine to connect in, and has no SSH target.
 */
export type HostKind = 'ssh' | 'worker';

/** What is shown of a worker host's token: never the token, only its last four characters and when it was minted. */
export interface WorkerTokenSummaryRow {
    hint: string;
    issuedAt: DateTime;
}

/** One `wilson.hosts` row with its `wilson.host_projects` rows. */
export interface HostRow {
    name: string;
    kind: HostKind;
    /** What `ssh` connects to. Set exactly when `kind` is `ssh`. */
    sshTarget?: string;
    slots: number;
    enabled: boolean;
    draining: boolean;
    /** Minutes it runs after boot before it stops by itself; absent when it has no known end. */
    lifetimeMinutes?: number;
    /** Variables the host's own environment supplies to configured commands there. */
    commandEnv: string[];
    /** Where a project with a GitHub repository can add itself on this host; absent, only `projects` are served. */
    projectsRoot?: string;
    projects: HostProjectRow[];
    /** Slots held by stages right now, slot order. */
    running: HostSlotUseRow[];
    /** Absent until the host has been probed once. */
    probe?: HostProbeRow;
    /** A worker host's current token, absent until one is minted. Never set on an `ssh` host. */
    workerToken?: WorkerTokenSummaryRow;
}

/**
 * The columns `update` may set; the probe's own columns are written only by `recordProbe`.
 * `lifetimeMinutes: null` clears it, the one place "explicitly emptied" differs from "left alone".
 */
export type HostPatch = Partial<Pick<HostRow, 'sshTarget' | 'slots' | 'enabled' | 'draining' | 'commandEnv'>> & {
    lifetimeMinutes?: number | null;
    projectsRoot?: string | null;
};

/**
 * `wilson.hosts` and `wilson.host_projects`, in Postgres: the machines a stage can run on besides
 * the daemon's own, and the projects each can serve.
 */
@Injectable()
export class HostRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Every host, name ascending, each with its projects in project order. */
    async list(): Promise<HostRow[]> {
        const hosts = await this.db.selectFrom('wilson.hosts').selectAll().orderBy('name').execute();
        if (hosts.length === 0) return [];

        const projects = await this.db
            .selectFrom('wilson.hostProjects')
            .selectAll()
            .where(
                'host',
                'in',
                hosts.map(h => h.name),
            )
            .orderBy('project')
            .execute();

        const slots = await this.slotsInUse();
        return hosts.map(host =>
            toRow(
                host,
                projects.filter(p => p.host === host.name),
                slots,
            ),
        );
    }

    /** The named host, or undefined when none is registered under it. */
    async find(name: string): Promise<HostRow | undefined> {
        const host = await this.db.selectFrom('wilson.hosts').selectAll().where('name', '=', name).executeTakeFirst();
        if (!host) return undefined;

        const projects = await this.db.selectFrom('wilson.hostProjects').selectAll().where('host', '=', name).orderBy('project').execute();
        return toRow(host, projects, await this.slotsInUse());
    }

    /**
     * Every held host slot. Read whole and matched to hosts in code, by `hostSlotKey`'s prefix, rather
     * than with a `LIKE` per host, since a host name may hold `%` or `_`; there are only ever a handful.
     */
    private async slotsInUse(): Promise<SlotLease[]> {
        return this.db
            .selectFrom('wilson.leases')
            .select(['resourceKey', 'project', 'cardId', 'acquiredAt'])
            .where('resourceKey', 'like', 'host:%')
            .execute();
    }

    /** Register a host. Fails if the name is already taken. */
    async create(row: {
        name: string;
        kind: HostKind;
        sshTarget?: string;
        slots: number;
        lifetimeMinutes?: number;
        commandEnv?: string[];
        projectsRoot?: string;
    }): Promise<void> {
        await this.db.insertInto('wilson.hosts').values(row).execute();
    }

    /**
     * Set whichever operator columns `patch` names. Returns whether a row matched `name`. An empty
     * patch is answered with a `find`, for the reason `ProjectRepository.update` gives: Kysely
     * compiles `set({})` to a SET clause Postgres rejects.
     */
    async update(name: string, patch: HostPatch): Promise<boolean> {
        if (Object.keys(patch).length === 0) {
            return (await this.find(name)) !== undefined;
        }
        const result = await this.db.updateTable('wilson.hosts').set(patch).where('name', '=', name).executeTakeFirst();
        return result.numUpdatedRows > 0n;
    }

    /** Remove a host and, by the foreign key's cascade, its projects. Returns whether one matched. */
    async remove(name: string): Promise<boolean> {
        const result = await this.db.deleteFrom('wilson.hosts').where('name', '=', name).executeTakeFirst();
        return result.numDeletedRows > 0n;
    }

    /** Set one project's three paths on a host, replacing any it had. */
    async putProject(host: string, row: HostProjectRow): Promise<void> {
        await this.db
            .insertInto('wilson.hostProjects')
            .values({ host, ...row })
            .onConflict(oc =>
                oc.columns(['host', 'project']).doUpdateSet({ codeRoot: row.codeRoot, worktreeRoot: row.worktreeRoot, runRoot: row.runRoot }),
            )
            .execute();
    }

    /** Stop a host serving a project. Returns whether it was serving it. */
    async removeProject(host: string, project: string): Promise<boolean> {
        const result = await this.db.deleteFrom('wilson.hostProjects').where('host', '=', host).where('project', '=', project).executeTakeFirst();
        return result.numDeletedRows > 0n;
    }

    /** Keep `hash` as host `name`'s worker token, replacing any it had. Returns whether a row matched. */
    async setWorkerToken(name: string, token: { hash: string; hint: string; issuedAt: DateTime }): Promise<boolean> {
        const result = await this.db
            .updateTable('wilson.hosts')
            .set({ workerTokenHash: token.hash, workerTokenHint: token.hint, workerTokenIssuedAt: token.issuedAt })
            .where('name', '=', name)
            .executeTakeFirst();
        return result.numUpdatedRows > 0n;
    }

    /** Forget host `name`'s worker token, so nothing can connect as it. Returns whether a row matched. */
    async clearWorkerToken(name: string): Promise<boolean> {
        const result = await this.db
            .updateTable('wilson.hosts')
            .set({ workerTokenHash: null, workerTokenHint: null, workerTokenIssuedAt: null })
            .where('name', '=', name)
            .executeTakeFirst();
        return result.numUpdatedRows > 0n;
    }

    /** The host whose worker token hashes to `hash`, or undefined when none does. */
    async findByWorkerTokenHash(hash: string): Promise<HostRow | undefined> {
        const host = await this.db.selectFrom('wilson.hosts').select('name').where('workerTokenHash', '=', hash).executeTakeFirst();
        return host ? this.find(host.name) : undefined;
    }

    /** Record what a probe found, replacing the last one. Every probe column is written, set or not. */
    async recordProbe(name: string, probe: HostProbeRow): Promise<void> {
        await this.db
            .updateTable('wilson.hosts')
            .set({
                probedAt: probe.probedAt,
                probeOk: probe.ok,
                probeDetail: probe.detail ?? null,
                engineVersion: probe.engineVersion ?? null,
                expiresAt: probe.expiresAt ?? null,
            })
            .where('name', '=', name)
            .execute();
    }
}

/**
 * A `wilson.hosts` row as Kysely hands it back. The nullable columns are `undefined` when unset, not
 * `null`: `KyselyDefaultPlugins` includes `NullToUndefinedPlugin`, whatever `db.ts` declares.
 */
type HostSelection = {
    name: string;
    kind: string;
    sshTarget?: string | null;
    slots: number;
    enabled: boolean;
    draining: boolean;
    probedAt?: DateTime | null;
    probeOk?: boolean | null;
    probeDetail?: string | null;
    engineVersion?: string | null;
    expiresAt?: DateTime | null;
    lifetimeMinutes?: number | null;
    commandEnv: string[];
    projectsRoot?: string | null;
    workerTokenHint?: string | null;
    workerTokenIssuedAt?: DateTime | null;
};

const toRow = (host: HostSelection, projects: HostProjectRow[], slots: SlotLease[]): HostRow => ({
    name: host.name,
    kind: host.kind as HostKind,
    ...(host.sshTarget && { sshTarget: host.sshTarget }),
    slots: host.slots,
    enabled: host.enabled,
    draining: host.draining,
    ...(host.lifetimeMinutes && { lifetimeMinutes: host.lifetimeMinutes }),
    commandEnv: host.commandEnv,
    ...(host.projectsRoot && { projectsRoot: host.projectsRoot }),
    projects: projects.map(({ project, codeRoot, worktreeRoot, runRoot }) => ({ project, codeRoot, worktreeRoot, runRoot })),
    running: slots
        .filter(lease => lease.resourceKey.startsWith(slotPrefix(host.name)))
        .map(lease => ({
            slot: Number(lease.resourceKey.slice(slotPrefix(host.name).length)),
            project: lease.project,
            cardId: lease.cardId,
            since: lease.acquiredAt,
        }))
        .sort((a, b) => a.slot - b.slot),
    ...(host.probedAt && typeof host.probeOk === 'boolean'
        ? {
              probe: {
                  probedAt: host.probedAt,
                  ok: host.probeOk,
                  ...(host.probeDetail && { detail: host.probeDetail }),
                  ...(host.engineVersion && { engineVersion: host.engineVersion }),
                  ...(host.expiresAt && { expiresAt: host.expiresAt }),
              },
          }
        : {}),
    ...(host.workerTokenHint && host.workerTokenIssuedAt && { workerToken: { hint: host.workerTokenHint, issuedAt: host.workerTokenIssuedAt } }),
});
