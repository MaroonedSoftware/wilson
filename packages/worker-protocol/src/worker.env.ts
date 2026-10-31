/**
 * How a worker builds the environment of what it runs, so a stage on a worker sees what it would on
 * an SSH host (`SshHost`, `apps/api/src/modules/host/ssh.execution.host.ts`): Wilson says what to set,
 * and a fixed set of names always comes from the worker's own machine instead, since Wilson's values
 * for them (`PATH`, `HOME`) name folders that only exist where Wilson runs.
 */

/**
 * Names taken from the worker's own environment whatever Wilson sends. The same list as
 * `PASSED_THROUGH` in `apps/api/src/modules/stages/run.command.ts`; a test there keeps the two equal.
 */
export const PASSED_THROUGH_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SHELL', 'USER', 'NODE_ENV'] as const;

/** The variable `claude` signs in with when it is set, as `claude setup-token` documents. */
export const ENGINE_TOKEN_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';

/** The variable the worker program connects to Wilson with. */
export const WORKER_TOKEN_VARIABLE = 'WILSON_WORKER_TOKEN';

/** The prefixes of the variables the Agent SDK sets for the engine, the only ones a `spawn` carries. */
export const ENGINE_ENV_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_'] as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Each of `names` that `own` sets, with `own`'s value. */
const pick = (own: Env, names: readonly string[]): Record<string, string> => {
    const picked: Record<string, string> = {};
    for (const name of names) {
        const value = own[name];
        if (value !== undefined) picked[name] = value;
    }
    return picked;
};

/**
 * The environment for an `exec` that sent one: Wilson's `env`, except that the passthrough names and
 * `hostEnv` take the worker's own values, or are left unset where the worker has none. The same
 * result as `SshHost`'s `env -i` prefix.
 */
export const commandEnvironment = (sent: Env, hostEnv: readonly string[], own: Env): Record<string, string> => {
    const fromWorker = [...PASSED_THROUGH_ENV, ...hostEnv];
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(sent)) {
        if (value !== undefined && !fromWorker.includes(key)) env[key] = value;
    }
    return { ...env, ...pick(own, fromWorker) };
};

/**
 * The environment for an `exec` that sent none, or a clone: the worker's own, without the two tokens
 * in it. Git runs a repository's hooks here, and a hook holding the worker token could connect as this
 * host and be sent the engine token Wilson assigns it.
 */
export const inheritedEnvironment = (own: Env): Env => {
    const env = { ...own };
    delete env[ENGINE_TOKEN_VARIABLE];
    delete env[WORKER_TOKEN_VARIABLE];
    return env;
};

/**
 * The environment for the engine: the SDK's own variables from `sent` and nothing else of Wilson's,
 * the passthrough names from the worker, and `assigned`, the token Wilson gave this process, or else
 * the worker's own. A token in `sent` is dropped: only the host's assignment decides, so the token an
 * engine on Wilson's own machine uses can never sign in an engine here.
 */
export const engineEnvironment = (sent: Env, own: Env, assigned?: string): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(sent)) {
        if (value === undefined || key === ENGINE_TOKEN_VARIABLE) continue;
        if (ENGINE_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) env[key] = value;
    }
    return {
        ...env,
        ...pick(own, [...PASSED_THROUGH_ENV, ENGINE_TOKEN_VARIABLE]),
        ...(assigned !== undefined && { [ENGINE_TOKEN_VARIABLE]: assigned }),
    };
};
