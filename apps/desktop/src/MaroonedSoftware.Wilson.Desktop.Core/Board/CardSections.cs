using System.Text.Json;
using System.Text.RegularExpressions;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Board;

/// <summary>An acceptance criterion, with its stable id.</summary>
public sealed record Criterion(string Id, string Text);

/// <summary>What the plan's sections and a card's events say, by the web app's `lib/card.ts` and `CriteriaPanel.tsx`.</summary>
public static partial class CardSections
{
    public const string FilesInScopeKey = "files-in-scope";
    public const string AcceptanceCriteriaKey = "acceptance-criteria";

    public static IReadOnlyList<string> FilesInScope(string? section) => string.IsNullOrEmpty(section) ? [] : Bullets(section);

    /// <summary>A leading `AC1:`, `AC-1:` or `AC1.` is a criterion's id, and one without gets its place in the list.</summary>
    public static IReadOnlyList<Criterion> AcceptanceCriteria(string? section)
    {
        if (string.IsNullOrEmpty(section))
        {
            return [];
        }

        return [.. Bullets(section).Select((bullet, index) =>
        {
            var match = CriterionId().Match(bullet);
            return match.Success
                ? new Criterion($"AC{match.Groups[1].Value}", match.Groups[2].Value.Trim())
                : new Criterion($"AC{index + 1}", bullet);
        })];
    }

    /// <summary>
    /// The status each criterion got from the latest review. Nothing means no review reported any,
    /// and this is a read of what it said, not a second opinion. `events` run oldest first.
    /// </summary>
    public static IReadOnlyDictionary<string, string> ReviewStatuses(IEnumerable<CardEvent> events)
    {
        ArgumentNullException.ThrowIfNull(events);

        var latest = events.LastOrDefault(entry => entry.Stage == "review" && entry.Type is "stage.passed" or "stage.failed");
        if (latest is null
            || latest.Payload.ValueKind != JsonValueKind.Object
            || !latest.Payload.TryGetProperty("result", out var result)
            || result.ValueKind != JsonValueKind.Object
            || !result.TryGetProperty("criteria", out var criteria)
            || criteria.ValueKind != JsonValueKind.Array)
        {
            return new Dictionary<string, string>();
        }

        var statuses = new Dictionary<string, string>();
        foreach (var entry in criteria.EnumerateArray())
        {
            if (Text(entry, "id") is { } id && Text(entry, "status") is "met" or "unmet" or "unverifiable")
            {
                statuses[id] = Text(entry, "status")!;
            }
        }

        return statuses;
    }

    /// <summary>
    /// The registered host the most recent stage ran on, or none when it ran on the server itself: a
    /// `stage.placed` names the host for the `stage.dispatched` that follows it.
    /// </summary>
    public static string? LastStageHost(IEnumerable<CardEvent> events)
    {
        ArgumentNullException.ThrowIfNull(events);

        string? placedOn = null;
        string? ranOn = null;
        foreach (var entry in events)
        {
            if (entry.Type == "stage.placed")
            {
                placedOn = Text(entry.Payload, "host");
            }
            else if (entry.Type == "stage.dispatched")
            {
                ranOn = placedOn;
                placedOn = null;
            }
        }

        return ranOn;
    }

    /// <summary>The line under an event: a deferral's reason, where a stage was placed, or the host that stopped answering.</summary>
    public static string? EventDetail(CardEvent entry)
    {
        ArgumentNullException.ThrowIfNull(entry);

        var host = Text(entry.Payload, "host");
        return entry.Type switch
        {
            "dispatch.deferred" => Text(entry.Payload, "reason"),
            "stage.placed" when host is not null => $"on {host}",
            "stage.host-lost" when host is not null => Text(entry.Payload, "reason") is { } reason ? $"{host} stopped answering: {reason}" : $"{host} stopped answering",
            _ => null,
        };
    }

    /// <summary>
    /// A section's bullets, as `splitBullets` in the API reads them. A line with no marker continues
    /// the bullet above and a blank line ends it. With no markers at all, each line is one item.
    /// </summary>
    private static List<string> Bullets(string raw)
    {
        var lines = raw.Split('\n');
        static string Clean(string line) => line.Replace("`", string.Empty, StringComparison.Ordinal).Trim();
        if (!lines.Any(line => line.Trim().Length > 0 && Marker().IsMatch(line)))
        {
            return [.. lines.Select(Clean).Where(line => line.Length > 0 && !line.StartsWith("<!--", StringComparison.Ordinal))];
        }

        var items = new List<string>();
        string? current = null;
        foreach (var line in lines)
        {
            if (line.Trim().Length == 0)
            {
                if (current is not null)
                {
                    items.Add(current);
                }

                current = null;
            }
            else if (line.Trim().StartsWith("<!--", StringComparison.Ordinal))
            {
                continue;
            }
            else if (Marker().IsMatch(line))
            {
                if (current is not null)
                {
                    items.Add(current);
                }

                current = Clean(Marker().Replace(line, string.Empty, 1));
            }
            else
            {
                current = current is null ? Clean(line) : $"{current} {Clean(line)}";
            }
        }

        if (current is not null)
        {
            items.Add(current);
        }

        return [.. items.Where(item => item.Length > 0)];
    }

    private static string? Text(JsonElement element, string field) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } text ? text : null;

    [GeneratedRegex(@"^\s*[-*+]\s*")]
    private static partial Regex Marker();

    [GeneratedRegex(@"^AC-?(\d+)[:.]\s*(.*)$")]
    private static partial Regex CriterionId();
}
