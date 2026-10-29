import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { DateTime } from 'luxon';
import { LeaseService } from '#modules/lease/lease.service.js';
import { LOCAL_STAGE_SLOTS } from '#modules/settings/local.stage.slots.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import { HostConnector } from './host.connector.js';
import { HostRepository, type HostRow } from './host.repository.js';
import { hostSlotKey, localSlotKey, type RemotePlacement } from './placement.js';

/**
 * Margin past a stage's `maxWallClockMs` a host must still have before it expires: setup, the
 * verifier and the commit all run after the agent's own clock stops.
 */
const EXPIRY_MARGIN_MINUTES = 15;

/** How long the reachability check before placing may take. */
const REACH_TIMEOUT_MS = 15_000;

/** Why no host took a stage, for the deferral an operator reads. */
export class NoHostAvailable {
    constructor(readonly reasons: string[]) {}

    get message(): string {
        return this.reasons.length > 0 ? `no host can take it: ${this.reasons.join('; ')}` : 'no host is registered for this project';
    }
}

/**
 * Picks the host a stage runs on, and takes a slot there.
 *
 * A host is a candidate only when everything an operator and the last probe said about it allows it:
 * enabled, not draining, serving the card's project, its last probe passed, and not due to expire
 * before the stage could finish. Candidates are tried in name order, each slot in turn; a slot is a
 * `wilson.leases` row, so two stages cannot hold one and a slot held by a card with no live job is
 * swept the way any lease is (`LeaseService.acquire`). Before a slot is kept, the host is reached
 * once: a probe can be hours old, and an agent VM is gone the moment it is deleted.
 */
@Injectable()
export class HostPlacer {
    constructor(
        private readonly hosts: HostRepository,
        private readonly connector: HostConnector,
        private readonly leases: LeaseService,
        private readonly logger: Logger,
        // Optional so a test can build a placer without one; unset reads as the setting's default.
        private readonly settings?: SettingsStore,
    ) {}

    /**
     * Take one of this machine's `local-stage-slots` for `cardId`: its key, or how many slots there
     * are when every one is held. The caller releases it with `releaseSlot` when the stage ends.
     */
    async takeLocalSlot(project: string, cardId: string): Promise<{ key: string } | { busy: number }> {
        const slots = this.settings ? await this.settings.get(LOCAL_STAGE_SLOTS) : LOCAL_STAGE_SLOTS.defaultValue;
        for (let slot = 1; slot <= slots; slot++) {
            const key = localSlotKey(slot);
            if ((await this.leases.acquire(key, project, cardId)).acquired) return { key };
        }
        return { busy: slots };
    }

    /** Give back a slot a stage held, here or on a host. Safe when it is no longer held. */
    async releaseSlot(key: string, project: string, cardId: string): Promise<void> {
        await this.leases.release(key, project, cardId);
    }

    /**
     * Place `stage` for `cardId`. `undefined` means run it here: the stage is `local`, has no
     * worktree, or is `any` and found no host. A `NoHostAvailable` means it is `remote` and found
     * none, which the caller defers.
     */
    async place(
        project: string,
        cardId: string,
        stage: Pick<StageConfig, 'placement' | 'worktree' | 'maxWallClockMs'>,
    ): Promise<RemotePlacement | NoHostAvailable | undefined> {
        const wanted = stage.placement ?? 'local';
        if (wanted === 'local' || stage.worktree === 'none') return undefined;

        const reasons: string[] = [];
        const deadline = DateTime.now().plus({ milliseconds: stage.maxWallClockMs, minutes: EXPIRY_MARGIN_MINUTES });

        for (const row of await this.hosts.list()) {
            const serves = row.projects.find(p => p.project === project);
            if (!serves) continue;

            const refusal = unsuitable(row, deadline);
            if (refusal) {
                reasons.push(`${row.name} ${refusal}`);
                continue;
            }

            const slotKey = await this.takeSlot(row, project, cardId);
            if (!slotKey) {
                reasons.push(`${row.name} has all ${row.slots} slot${row.slots === 1 ? '' : 's'} in use`);
                continue;
            }

            const host = this.connector.connect(row);
            const reached = await host.exec('true', [], { cwd: '/', env: {}, timeoutMs: REACH_TIMEOUT_MS }).then(
                () => true,
                (err: Error) => {
                    reasons.push(`${row.name} did not answer: ${err.message}`);
                    return false;
                },
            );
            if (!reached) {
                await this.leases.release(slotKey, project, cardId);
                continue;
            }

            this.logger.info(`${cardId} placed on ${row.name} (${slotKey})`);
            return {
                hostName: row.name,
                host,
                git: this.connector.gitTransport(row),
                codeRoot: serves.codeRoot,
                worktreeRoot: serves.worktreeRoot,
                runRoot: serves.runRoot,
                slotKey,
            };
        }

        return wanted === 'remote' ? new NoHostAvailable(reasons) : undefined;
    }

    /** Whether a placed stage's host still answers. */
    async isAlive(placement: RemotePlacement): Promise<boolean> {
        return placement.host.exec('true', [], { cwd: '/', env: {}, timeoutMs: REACH_TIMEOUT_MS }).then(
            () => true,
            () => false,
        );
    }

    /**
     * Record that a host was lost mid-stage, as a failed probe, so placement passes it over until
     * someone probes it again and it answers.
     */
    async markLost(placement: RemotePlacement, detail: string): Promise<void> {
        await this.hosts.recordProbe(placement.hostName, { probedAt: DateTime.now(), ok: false, detail: `lost during a stage: ${detail}` });
        this.logger.warn(`${placement.hostName} stopped answering: ${detail}`);
    }

    /** The first free slot on `row`, now held by `cardId`, or undefined when every one is taken. */
    private async takeSlot(row: HostRow, project: string, cardId: string): Promise<string | undefined> {
        for (let slot = 1; slot <= row.slots; slot++) {
            const key = hostSlotKey(row.name, slot);
            if ((await this.leases.acquire(key, project, cardId)).acquired) return key;
        }
        return undefined;
    }
}

/** Why `row` cannot take a stage that must finish by `deadline`, or undefined when it can. */
const unsuitable = (row: HostRow, deadline: DateTime): string | undefined => {
    if (!row.enabled) return 'is disabled';
    if (row.draining) return 'is draining';
    if (!row.probe) return 'has never been probed';
    if (!row.probe.ok) return `failed its last probe (${row.probe.detail ?? 'no reason recorded'})`;
    if (row.probe.expiresAt && row.probe.expiresAt < deadline) return `expires at ${row.probe.expiresAt.toISO()}, before the stage could finish`;
    return undefined;
};
