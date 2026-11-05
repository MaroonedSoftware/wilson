import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);

/**
 * What an app may ask the web app for. All of it is read-only, and all of it is about the project the
 * app was opened in.
 * generated from [AppGrant](../../data/contracts/apps.ck)
 */
export const AppGrant = z.enum(['board.read', 'activity.read', 'stats.read']);
export type AppGrant = z.infer<typeof AppGrant>;

/**
 * An app as a list shows it, without its HTML.
 * generated from [AppSummary](../../data/contracts/apps.ck)
 */
export const AppSummary = z.strictObject({
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    grants: z.array(AppGrant),
    createdAt: _ZodDatetime,
    updatedAt: _ZodDatetime,
});
export type AppSummary = z.infer<typeof AppSummary>;

/**
 * An app and what it runs.
 * generated from [App](../../data/contracts/apps.ck)
 */
export const App = z.strictObject({
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    grants: z.array(AppGrant),
    html: z.string(),
    createdAt: _ZodDatetime,
    updatedAt: _ZodDatetime,
});
export type App = z.infer<typeof App>;

/**
 * generated from [InstallAppRequest](../../data/contracts/apps.ck)
 */
export const InstallAppRequest = z.strictObject({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional().describe('Unset means no description.'),
    html: z.string().min(1).describe('The whole app, at most 512 KiB once encoded as UTF-8.'),
    grants: z.array(AppGrant).describe('Replaces whatever grants the app had before.'),
});
export type InstallAppRequest = z.infer<typeof InstallAppRequest>;
