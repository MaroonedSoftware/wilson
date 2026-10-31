import { Injectable } from 'injectkit';
import { Kysely, sql } from 'kysely';
import type { DB } from '#modules/data/db.js';

/** One phone that receives push notifications. */
export interface PushDevice {
    readonly token: string;
    readonly accountId: string;
    readonly label?: string;
}

/** `wilson.push_devices`. There is one operator, so reading them all is reading theirs. */
@Injectable()
export class DeviceRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Adds the token, or takes it over when the phone signs in again, even to another account. */
    async register(device: PushDevice): Promise<void> {
        await this.db
            .insertInto('wilson.pushDevices')
            .values({ token: device.token, accountId: device.accountId, label: device.label ?? null })
            .onConflict(conflict =>
                conflict.column('token').doUpdateSet({ accountId: device.accountId, label: device.label ?? null, lastSeenAt: sql`now()` }),
            )
            .execute();
    }

    async remove(token: string): Promise<void> {
        await this.db.deleteFrom('wilson.pushDevices').where('token', '=', token).execute();
    }

    async tokens(): Promise<string[]> {
        const rows = await this.db.selectFrom('wilson.pushDevices').select('token').execute();
        return rows.map(row => row.token);
    }
}
