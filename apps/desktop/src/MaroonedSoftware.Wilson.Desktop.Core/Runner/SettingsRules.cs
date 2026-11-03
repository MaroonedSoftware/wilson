using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Runner;

/// <summary>What `routes/settings.tsx`, `DrainControl.tsx` and `DrainIndicator.tsx` say, kept in step by hand.</summary>
public static class SettingsRules
{
    /// <summary>The header's word for a server that is draining, and nothing for one that is not.</summary>
    public static string? DrainBadge(DrainStatus status)
    {
        ArgumentNullException.ThrowIfNull(status);

        return !status.Draining ? null : status.SafeToRestart ? "Safe to restart" : "Draining";
    }

    /// <summary>What a restart would still interrupt, while draining.</summary>
    public static string? DrainLine(DrainStatus status)
    {
        ArgumentNullException.ThrowIfNull(status);

        if (!status.Draining)
        {
            return null;
        }

        var running = status.Running.Count > 0 ? $" ({string.Join(", ", status.Running.Select(card => $"{card.Project}/{card.CardId}"))})" : string.Empty;
        return $"{(status.SafeToRestart ? "Safe to restart." : "Not safe to restart yet.")} {status.Running.Count} running{running}, {status.Held} held, {status.PlanDrafts} plan drafts.";
    }

    /// <summary>Where engines on this machine get their sign-in, since the API never reports the token.</summary>
    public static string EngineTokenSource(EngineTokenSettingSource source) => source switch
    {
        EngineTokenSettingSource.Database => "Engines on this machine sign in with the token saved here.",
        EngineTokenSettingSource.Environment => "Engines on this machine sign in with CLAUDE_CODE_OAUTH_TOKEN from the environment. A token saved here replaces it.",
        _ => "No token is set, so engines on this machine use the login in their Claude config directory.",
    };

    /// <summary>What running on an engine means.</summary>
    public static string ChatEngineHint(ChatEngineSettingEngine engine) =>
        (engine == ChatEngineSettingEngine.Cli
            ? "Runs on the Claude subscription the stages use, from the accounts above. No API key needed."
            : "Runs against the provider's API key in apps/api/.env, billed per token.")
        + " Applies to chats started afterwards. A chat keeps the engine it started on.";

    /// <summary>Whether a lane can leave Claude's engine. Its session always runs Claude on `planning` and `ready`, whatever is routed.</summary>
    public static bool ChoosesAdapter(string stage) => stage is not ("planning" or "ready");

    /// <summary>Whether a provider is the operator's to pick. The `cli` engine and a planning session always run Claude, and the API refuses anything else.</summary>
    public static bool ChoosesProvider(string stage, StageRoutingAdapter adapter) => adapter == StageRoutingAdapter.Api && ChoosesAdapter(stage);

    /// <summary>The lanes that reach a model. Manual lanes never do, bar `planning` and `ready`.</summary>
    public static IReadOnlyList<StageRouting> RoutedLanes(IEnumerable<StageRouting> routes) =>
        [.. routes.Where(route => route.Mode == StageRoutingMode.Agent || !ChoosesAdapter(route.Stage))];

    /// <summary>The provider a draft holds once its engine changes: `cli` is only Anthropic and `codex` only OpenAI.</summary>
    public static StageRoutingProvider ProviderOn(StageRoutingAdapter adapter, StageRoutingProvider current) => adapter switch
    {
        StageRoutingAdapter.Cli => StageRoutingProvider.Anthropic,
        StageRoutingAdapter.Codex => StageRoutingProvider.Openai,
        _ => current,
    };

    /// <summary>What a lane's empty model falls back on, for the one lane that has a fallback.</summary>
    public static string? ModelPlaceholder(string stage) => stage == "ready" ? "The chat engine's model" : null;

    /// <summary>The warning when `review` and `implementing` run on one provider, or none. Worth saying, never refused.</summary>
    public static string? SharedProvider(IEnumerable<StageRouting> routes)
    {
        ArgumentNullException.ThrowIfNull(routes);

        var routed = routes.ToList();
        var review = routed.Find(route => route.Stage == "review")?.Provider;
        var implementing = routed.Find(route => route.Stage == "implementing")?.Provider;
        return review is { } provider && provider != StageRoutingProvider.Unknown && provider == implementing
            ? $"Review and implementing both run on {provider.ToString().ToLowerInvariant()}. An adversarial review catches more from a different provider than the one that wrote the code."
            : null;
    }

    /// <summary>A lane's route as sent, or none while it holds a value this SDK does not know, which cannot be written.</summary>
    public static SetStageRoutingRequest? RoutingRequest(StageRoutingAdapter adapter, StageRoutingProvider provider, string model)
    {
        SetStageRoutingRequestAdapter? sentAdapter = adapter switch
        {
            StageRoutingAdapter.Api => SetStageRoutingRequestAdapter.Api,
            StageRoutingAdapter.Cli => SetStageRoutingRequestAdapter.Cli,
            StageRoutingAdapter.Codex => SetStageRoutingRequestAdapter.Codex,
            _ => null,
        };
        SetStageRoutingRequestProvider? sentProvider = provider switch
        {
            StageRoutingProvider.Anthropic => SetStageRoutingRequestProvider.Anthropic,
            StageRoutingProvider.Openai => SetStageRoutingRequestProvider.Openai,
            StageRoutingProvider.Xai => SetStageRoutingRequestProvider.Xai,
            _ => null,
        };
        return sentAdapter is { } a && sentProvider is { } p ? new SetStageRoutingRequest { Adapter = a, Provider = p, Model = model } : null;
    }

    /// <summary>The GitHub App's key is never entered here, only reported.</summary>
    public static string GitHubKey(bool installed) => installed
        ? "Private key found."
        : "Private key not found. Put it at secrets/github-app.pem in the data folder on the machine Wilson runs on.";

    /// <summary>A text setting as sent: empty means not set, which the API spells null.</summary>
    public static string? Sent(string? draft) => string.IsNullOrWhiteSpace(draft) ? null : draft.Trim();

    /// <summary>A value beside a refusal, so neither the attempt nor what is really stored is lost.</summary>
    public static string StillSaved(string? stored) => $"Still saved: {stored ?? "not set"}";
}
