import { Injectable } from 'injectkit';
// A value import, not `import type`: `@Injectable()`'s `design:paramtypes` metadata has to name
// `Kysely` as a value, the reason `ProjectRepository` gives for the same line.
import { Kysely, sql } from 'kysely';
import type { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';
import type { McpToolAccess, McpToolReview } from '../../generated/mcp.connections.js';
import type { ListedTool } from './mcp.client.js';

export interface McpConnectionRow {
    name: string;
    url: string;
    secret?: string;
    project?: string;
    refreshedAt: DateTime;
    createdAt: DateTime;
    updatedAt: DateTime;
}

export interface McpToolRow {
    connection: string;
    name: string;
    description: string;
    inputSchema: unknown;
    readOnlyHint: boolean;
    access: McpToolAccess;
    fingerprint: string;
    approvedFingerprint?: string;
}

/** Whether a person reviewed what the server lists now, and allowed it. */
export const isUsable = (tool: Pick<McpToolRow, 'access' | 'fingerprint' | 'approvedFingerprint'>): boolean =>
    tool.access !== 'disabled' && tool.approvedFingerprint === tool.fingerprint;

/** `wilson.mcp_connections` and `wilson.mcp_connection_tools`, in Postgres. */
@Injectable()
export class McpConnectionRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Every connection, name ascending. */
    async list(): Promise<McpConnectionRow[]> {
        const rows = await this.db.selectFrom('wilson.mcpConnections').selectAll().orderBy('name').execute();
        return rows.map(toConnection);
    }

    async find(name: string): Promise<McpConnectionRow | undefined> {
        const row = await this.db.selectFrom('wilson.mcpConnections').selectAll().where('name', '=', name).executeTakeFirst();
        return row && toConnection(row);
    }

    /** The tools of `connection`, or of every connection when it is left out, name ascending. */
    async tools(connection?: string): Promise<McpToolRow[]> {
        let query = this.db.selectFrom('wilson.mcpConnectionTools').selectAll().orderBy('connection').orderBy('name');
        if (connection !== undefined) query = query.where('connection', '=', connection);
        return (await query.execute()).map(toTool);
    }

    /**
     * Save a connection and what its server lists, replacing any saved under `name`. A new address
     * forgets every review, since it may be another server altogether.
     */
    async put(name: string, connection: { url: string; secret?: string; project?: string }, listed: readonly ListedTool[]): Promise<void> {
        const { url, secret = null, project = null } = connection;
        await this.db.transaction().execute(async trx => {
            const saved = await trx.selectFrom('wilson.mcpConnections').select('url').where('name', '=', name).forUpdate().executeTakeFirst();
            if (saved && saved.url !== url) await trx.deleteFrom('wilson.mcpConnectionTools').where('connection', '=', name).execute();
            await trx
                .insertInto('wilson.mcpConnections')
                .values({ name, url, secret, project })
                .onConflict(oc => oc.column('name').doUpdateSet({ url, secret, project, updatedAt: sql`now()` }))
                .execute();
            await applyListing(trx, name, listed);
        });
    }

    /**
     * Record what a server lists now. A tool it no longer lists is forgotten. One it lists differently
     * keeps its access and its old approval, which no longer matches, so it stops being usable.
     */
    async refresh(name: string, listed: readonly ListedTool[]): Promise<void> {
        await this.db.transaction().execute(trx => applyListing(trx, name, listed));
    }

    /** Set the access of each tool in `reviews` and approve what it is listed as now. Answers the names that matched. */
    async review(connection: string, reviews: readonly McpToolReview[]): Promise<string[]> {
        return this.db.transaction().execute(async trx => {
            const matched: string[] = [];
            for (const { name, access } of reviews) {
                const updated = await trx
                    .updateTable('wilson.mcpConnectionTools')
                    .set(eb => ({ access, approvedFingerprint: eb.ref('fingerprint') }))
                    .where('connection', '=', connection)
                    .where('name', '=', name)
                    .executeTakeFirst();
                if (updated.numUpdatedRows > 0n) matched.push(name);
            }
            return matched;
        });
    }

    /** Forget a connection and its tools. Returns whether a row matched. */
    async remove(name: string): Promise<boolean> {
        const result = await this.db.deleteFrom('wilson.mcpConnections').where('name', '=', name).executeTakeFirst();
        return result.numDeletedRows > 0n;
    }
}

const applyListing = async (trx: Kysely<DB>, connection: string, listed: readonly ListedTool[]): Promise<void> => {
    const stale = trx.deleteFrom('wilson.mcpConnectionTools').where('connection', '=', connection);
    await (
        listed.length > 0
            ? stale.where(
                  'name',
                  'not in',
                  listed.map(tool => tool.name),
              )
            : stale
    ).execute();
    for (const { name, description, inputSchema, readOnlyHint, fingerprint } of listed) {
        const schema = JSON.stringify(inputSchema);
        await trx
            .insertInto('wilson.mcpConnectionTools')
            .values({ connection, name, description, inputSchema: schema, readOnlyHint, fingerprint })
            .onConflict(oc => oc.columns(['connection', 'name']).doUpdateSet({ description, inputSchema: schema, readOnlyHint, fingerprint }))
            .execute();
    }
    await trx
        .updateTable('wilson.mcpConnections')
        .set({ refreshedAt: sql`now()` })
        .where('name', '=', connection)
        .execute();
};

const toConnection = (row: {
    name: string;
    url: string;
    secret: string | null;
    project: string | null;
    refreshedAt: DateTime;
    createdAt: DateTime;
    updatedAt: DateTime;
}): McpConnectionRow => ({ ...row, secret: row.secret ?? undefined, project: row.project ?? undefined });

const toTool = (row: {
    connection: string;
    name: string;
    description: string;
    inputSchema: unknown;
    readOnlyHint: boolean;
    access: McpToolAccess;
    fingerprint: string;
    approvedFingerprint: string | null;
}): McpToolRow => ({ ...row, approvedFingerprint: row.approvedFingerprint ?? undefined });
