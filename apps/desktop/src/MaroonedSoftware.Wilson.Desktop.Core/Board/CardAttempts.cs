using System.Globalization;
using System.Text.Json;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Board;

/// <summary>
/// One run of a stage, as the card's events record it. `running` is the latest with no ending yet,
/// and `interrupted` one a later attempt replaced with none, as a daemon restart leaves behind.
/// </summary>
public sealed record CardAttempt(string Id, string Stage, DateTimeOffset StartedAt)
{
    public string Outcome { get; init; } = "running";

    /// <summary>Everything the run was sent, cached tokens included.</summary>
    public long? InputTokens { get; init; }

    public long? OutputTokens { get; init; }

    public int ToolCalls { get; init; }

    public int Denials { get; init; }

    /// <summary>Every read the run made. Absent for an attempt recorded before traces existed.</summary>
    public long? Reads { get; init; }

    public IReadOnlyList<string> ReadPaths { get; init; } = [];

    public string? FinalMessage { get; init; }

    public IReadOnlyList<string> Failures { get; init; } = [];

    /// <summary>The one line under an attempt's heading.</summary>
    public string Tally => string.Join(" · ", new[]
    {
        InputTokens is { } input ? string.Create(CultureInfo.InvariantCulture, $"{input} input tokens") : null,
        string.Create(CultureInfo.InvariantCulture, $"{ToolCalls} tool calls"),
        Denials > 0 ? string.Create(CultureInfo.InvariantCulture, $"{Denials} refused") : null,
        Reads is { } reads ? string.Create(CultureInfo.InvariantCulture, $"{reads} reads") : null,
    }.OfType<string>());
}

/// <summary>A card's runs, by the web app's `lib/attempts.ts`.</summary>
public static class CardAttempts
{
    /// <summary>
    /// Newest first, from events oldest first. Events before the first `stage.dispatched` are dropped,
    /// since the list can be a tail of a longer history.
    /// </summary>
    public static IReadOnlyList<CardAttempt> Group(IEnumerable<CardEvent> events)
    {
        ArgumentNullException.ThrowIfNull(events);

        var attempts = new List<CardAttempt>();
        foreach (var entry in events)
        {
            var latest = attempts.Count > 0 ? attempts[^1] : null;
            if (entry.Type == "stage.dispatched")
            {
                if (latest is { Outcome: "running" })
                {
                    attempts[^1] = latest with { Outcome = "interrupted" };
                }

                attempts.Add(new CardAttempt(entry.Id, entry.Stage ?? "unknown", entry.CreatedAt));
                continue;
            }

            if (latest is not { Outcome: "running" })
            {
                continue;
            }

            attempts[^1] = entry.Type switch
            {
                "tool.executed" => latest with { ToolCalls = latest.ToolCalls + 1 },
                "tool.denied" => latest with { Denials = latest.Denials + 1 },
                "stage.passed" => Ended(latest, entry, "passed"),
                "stage.failed" => Ended(latest, entry, "failed"),
                "stage.poisoned" => Ended(latest, entry, "poisoned"),
                "stage.dead" => Ended(latest, entry, "dead"),
                _ => latest,
            };
        }

        attempts.Reverse();
        return attempts;
    }

    private static CardAttempt Ended(CardAttempt attempt, CardEvent entry, string outcome)
    {
        var usage = Field(entry.Payload, "usage");
        var trace = Field(entry.Payload, "trace");
        var input = Number(usage, "inputTokens");
        return attempt with
        {
            Outcome = outcome,
            InputTokens = input is null ? attempt.InputTokens : input + (Number(usage, "cachedInputTokens") ?? 0),
            OutputTokens = Number(usage, "outputTokens") ?? attempt.OutputTokens,
            Reads = Number(trace, "reads"),
            ReadPaths = Strings(trace, "readPaths"),
            FinalMessage = Field(trace, "finalMessage") is { ValueKind: JsonValueKind.String } message ? message.GetString() : attempt.FinalMessage,
            Failures = Strings(entry.Payload, "failures"),
        };
    }

    private static JsonElement? Field(JsonElement? element, string field) =>
        element is { ValueKind: JsonValueKind.Object } found && found.TryGetProperty(field, out var value) ? value : null;

    private static long? Number(JsonElement? element, string field) =>
        Field(element, field) is { ValueKind: JsonValueKind.Number } number && number.TryGetInt64(out var value) ? value : null;

    private static List<string> Strings(JsonElement? element, string field) =>
        Field(element, field) is { ValueKind: JsonValueKind.Array } list
            ? [.. list.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString()!)]
            : [];
}
