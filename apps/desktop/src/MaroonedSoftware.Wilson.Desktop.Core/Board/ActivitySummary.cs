using System.Text.Json;

namespace MaroonedSoftware.Wilson.Desktop.Core.Board;

/// <summary>How an activity row's dot reads.</summary>
public enum ActivityTone
{
    Quiet,
    Going,
    Good,
    Caution,
    Bad,
}

/// <summary>An event as a sentence, and its dot.</summary>
public sealed record ActivityLine(string Label, ActivityTone Tone);

/// <summary>The project activity page's wording, by the web app's `lib/activity.ts`.</summary>
public static class ActivitySummary
{
    private static readonly Dictionary<string, ActivityLine> Lines = new()
    {
        ["stage.dispatched"] = new("Started {stage}", ActivityTone.Going),
        ["stage.placed"] = new("Placed {stage} on a host", ActivityTone.Going),
        ["stage.host-lost"] = new("Lost the host running {stage}", ActivityTone.Caution),
        ["stage.passed"] = new("Passed {stage}", ActivityTone.Good),
        ["stage.failed"] = new("Failed {stage}", ActivityTone.Bad),
        ["stage.poisoned"] = new("Poisoned in {stage}", ActivityTone.Bad),
        ["stage.dead"] = new("Gave up on {stage}", ActivityTone.Bad),
        ["stage.stale"] = new("Abandoned a stale {stage} run", ActivityTone.Caution),
        ["test.flaky"] = new("Found a flaky test", ActivityTone.Caution),
        ["test.preexisting"] = new("Found a test already failing before this card", ActivityTone.Caution),
        ["rebase.conflict"] = new("Hit a rebase conflict", ActivityTone.Bad),
        ["context.overflow"] = new("Ran out of context in {stage}", ActivityTone.Bad),
        ["dispatch.deferred"] = new("Deferred dispatch", ActivityTone.Quiet),
        ["engine.failed"] = new("Engine failed in {stage}", ActivityTone.Bad),
        ["turn.empty"] = new("Engine ended its turn without working", ActivityTone.Caution),
        ["stage.compacted"] = new("Engine compacted its conversation in {stage}", ActivityTone.Quiet),
        ["scope.requested"] = new("Requested more scope", ActivityTone.Going),
        ["scope.granted"] = new("Scope granted", ActivityTone.Good),
        ["scope.refused"] = new("Scope refused", ActivityTone.Caution),
        ["work.committed"] = new("Committed work", ActivityTone.Good),
        ["transition.failed"] = new("Could not move the card", ActivityTone.Bad),
        ["chain.stopped"] = new("Stopped after {stage}", ActivityTone.Quiet),
        ["card.flagged"] = new("Flagged for a human", ActivityTone.Bad),
        ["card.acked"] = new("Flag acknowledged", ActivityTone.Good),
        ["card.answered"] = new("Question answered", ActivityTone.Good),
        ["stage.blocked"] = new("{stage} asked a question", ActivityTone.Caution),
        ["card.over-budget"] = new("Went over budget", ActivityTone.Bad),
        ["rule.verdicts"] = new("Checked the rules", ActivityTone.Going),
        ["rule.proposed"] = new("Looked for a rule to propose", ActivityTone.Going),
        ["card.auto-split"] = new("Split automatically", ActivityTone.Going),
        ["card.plan-drafted"] = new("Drafted a plan", ActivityTone.Good),
        ["job.orphaned"] = new("Recovered an orphaned job", ActivityTone.Caution),
    };

    /// <summary>A type with no wording shows as recorded, so one added later still appears.</summary>
    public static ActivityLine Summarize(string type, string? stage, JsonElement payload)
    {
        ArgumentNullException.ThrowIfNull(type);

        if (type == "transition.written")
        {
            return Text(payload, "to") is { } to && to != Text(payload, "from")
                ? new ActivityLine($"Moved to {to}", ActivityTone.Going)
                : new ActivityLine("Updated the card", ActivityTone.Quiet);
        }

        return Lines.TryGetValue(type, out var line)
            ? line with { Label = line.Label.Replace("{stage}", stage ?? "a stage", StringComparison.Ordinal) }
            : new ActivityLine(type, ActivityTone.Quiet);
    }

    /// <summary>Why it happened, when the event recorded a reason.</summary>
    public static string? Reason(JsonElement payload) => Text(payload, "reason") is { Length: > 0 } reason ? reason : null;

    private static string? Text(JsonElement payload, string field) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
