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
    version: z.string().optional().describe("The app's own label for what is installed. Absent for an app that did not say."),
    apiVersion: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .describe('The version of the app API (`app.api.ck`) the app was written for.'),
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
    version: z.string().optional().describe("The app's own label for what is installed. Absent for an app that did not say."),
    apiVersion: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .describe('The version of the app API (`app.api.ck`) the app was written for.'),
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
    version: z
        .string()
        .min(1)
        .max(50)
        .optional()
        .describe("The app's own label for this version. Unset means it did not say. Replaces any version stored before."),
    apiVersion: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .optional()
        .describe('The version of the app API it was written for. Unset means 1, the only one before apps said.'),
});
export type InstallAppRequest = z.infer<typeof InstallAppRequest>;
