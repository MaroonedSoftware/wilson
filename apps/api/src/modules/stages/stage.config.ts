import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { PROVIDERS } from '#modules/agent/model.registry.js';

/**
 * Stages are config, not code (PROJECT.md decision 8).
 *
 * Only `implementing` is configured today, but the shape is the full one — mode, worktree
 * requirement, routing, budget, targets — so adding the testing stage as card one is a config edit
 * plus a verifier, not a change to the dispatcher.
 */
export const StageConfigSchema = z.object({
    name: z.string(),
    mode: z.enum(['agent', 'command', 'manual']),
    worktree: z.enum(['none', 'readonly', 'rw']).default('rw'),
    provider: z.enum(PROVIDERS).default('anthropic'),
    model: z.string(),
    /** System guidance for the stage. The plan itself is passed as a file path, never inlined. */
    instructions: z.string(),
    /** Tool names this stage may use. Omit for all of them. */
    tools: z.array(z.string()).optional(),
    /** Commands the bash tool will run for this stage, as argv prefixes. */
    allowedCommands: z.array(z.string()).default([]),
    /** The command whose exit code the exit condition checks. */
    buildCommand: z.string().optional(),
    maxSteps: z.number().int().min(1).default(60),
    maxOutputTokens: z.number().int().min(1024).default(16000),
    onPass: z.string(),
    onFail: z.string(),
    maxKickbacks: z.number().int().min(0).default(3),
});

export type StageConfig = z.infer<typeof StageConfigSchema>;

export const ProjectStagesSchema = z.object({
    scopeViolation: z.enum(['widen', 'kickback']).default('widen'),
    /** Machine-owned paths no plan should have to mention. */
    alwaysAllowed: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    stages: z.array(StageConfigSchema),
});

export type ProjectStages = z.infer<typeof ProjectStagesSchema>;

export class StageConfigError extends Error {}

/**
 * Load `config/stages.yaml` from the board repo.
 *
 * Stage config lives on the board, not in the code repo, and the write tool denies it — an agent
 * that can edit its own exit condition passes every time (PROJECT.md decision 9).
 */
export const loadStages = async (boardRoot: string): Promise<ProjectStages> => {
    const path = join(boardRoot, 'config', 'stages.yaml');
    const raw = await readFile(path, 'utf8').catch((err: Error) => err);
    if (raw instanceof Error) {
        throw new StageConfigError(`could not read ${path}: ${raw.message}`);
    }

    const parsed = ProjectStagesSchema.safeParse(parseYaml(raw));
    if (!parsed.success) {
        throw new StageConfigError(
            `${path} is not valid stage config: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
    }
    return parsed.data;
};

export const findStage = (stages: ProjectStages, name: string): StageConfig => {
    const stage = stages.stages.find(s => s.name === name);
    if (!stage) {
        throw new StageConfigError(`no stage named "${name}" in stages.yaml (have: ${stages.stages.map(s => s.name).join(', ')})`);
    }
    return stage;
};
