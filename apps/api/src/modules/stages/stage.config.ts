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
    /**
     * Run once at worktree creation, before the agent starts.
     *
     * A fresh worktree has no node_modules, and without this the agent spends its budget installing
     * dependencies and confirming the baseline builds instead of doing the card.
     */
    /**
     * Where this stage's worktree comes from.
     *
     * `base` cuts fresh from HEAD — right for the first stage of a card, where every attempt starts
     * clean. `branch` re-opens the card's existing branch, which every later stage needs: the
     * testing stage works on the tree implementing produced.
     */
    worktreeFrom: z.enum(['base', 'branch']).default('base'),
    /**
     * Globs this stage may write on top of the card's own "Files in scope".
     *
     * A card's scope is written for the stage that implements it. The testing stage's whole job is
     * to add files nobody could have declared in advance, so it carries its own.
     */
    extraScope: z.array(z.string()).default([]),
    setupCommand: z.string().optional(),
    /** The command whose exit code the exit condition checks. */
    buildCommand: z.string().optional(),
    /** The command that runs the test suite and writes the report `testReportPath` points at. */
    testCommand: z.string().optional(),
    /** Where the test report lands, relative to the worktree. */
    testReportPath: z.string().optional(),
    /**
     * Whether the testing verifier should run the pre-change baseline: a second worktree, cut from
     * the same base, that proves this card's new tests fail before the change. Defaults on; the
     * escape hatch exists for stages where a baseline run cannot be completed at all rather than for
     * saving time (PROJECT.md decision on exit conditions that can be satisfied by doing less work).
     */
    baselineCheck: z.boolean().default(true),
    /** Name of the registered verifier to run at the exit condition. Defaults to the stage's own name. */
    verifier: z.string().optional(),
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

/**
 * States a card may occupy that are not agent stages.
 *
 * Terminal states end a card's life and nothing dispatches them, so they have no stage config
 * (PROJECT.md, Stage model). `parking-lot` is a column the dispatch query excludes.
 */
export const NON_STAGE_STATES = ['parking-lot', 'merged', 'needs-human', 'poisoned', 'dropped'] as const;

/**
 * Every state a card may legitimately be moved to.
 *
 * A stage the graph names as an on-pass or on-fail target counts even before anything implements
 * it: that is precisely the state of a half-built pipeline, and refusing it would mean a card that
 * passed `implementing` had nowhere to go.
 */
export const validTargets = (stages: ProjectStages): string[] => {
    const targets = new Set<string>(NON_STAGE_STATES);
    for (const stage of stages.stages) {
        targets.add(stage.name);
        targets.add(stage.onPass);
        targets.add(stage.onFail);
    }
    return [...targets].sort();
};

export const findStage = (stages: ProjectStages, name: string): StageConfig => {
    const stage = stages.stages.find(s => s.name === name);
    if (!stage) {
        throw new StageConfigError(`no stage named "${name}" in stages.yaml (have: ${stages.stages.map(s => s.name).join(', ')})`);
    }
    return { ...stage, verifier: stage.verifier ?? stage.name };
};
