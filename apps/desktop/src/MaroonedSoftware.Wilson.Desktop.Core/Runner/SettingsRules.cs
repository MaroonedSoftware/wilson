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

    /// <summary>A text setting as sent: empty means not set, which the API spells null.</summary>
    public static string? Sent(string? draft) => string.IsNullOrWhiteSpace(draft) ? null : draft.Trim();

    /// <summary>A value beside a refusal, so neither the attempt nor what is really stored is lost.</summary>
    public static string StillSaved(string? stored) => $"Still saved: {stored ?? "not set"}";
}
