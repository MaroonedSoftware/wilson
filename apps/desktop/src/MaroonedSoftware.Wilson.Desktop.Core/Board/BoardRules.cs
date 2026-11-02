using System.Text.Json;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Board;

/// <summary>How far a split origin has got.</summary>
public sealed record SplitProgress(int Merged, int Total);

/// <summary>What the board decides without a window. The same rules as the web board and the Android app.</summary>
public static class BoardRules
{
    public const string ParkingLot = "parking-lot";

    /// <summary>Past this, a tile's last-event line reads as stale. Five minutes, as the web board's.</summary>
    public static readonly TimeSpan LastEventStaleAfter = TimeSpan.FromMinutes(5);

    private const string Merged = "merged";

    /// <summary>
    /// The columns in order: parking lot, configured stages, terminal states. A stage a card sits in
    /// that the config does not name is appended, because a card that appears nowhere is a board
    /// quietly disagreeing with the database.
    /// </summary>
    public static IReadOnlyList<string> ColumnOrder(BoardColumns columns, IEnumerable<CardSummary> cards)
    {
        ArgumentNullException.ThrowIfNull(columns);

        List<string> known = [ParkingLot, .. columns.Stages, .. columns.NonStages.Where(stage => stage != ParkingLot)];
        return [.. known, .. cards.Select(card => card.Stage).Distinct().Where(stage => !known.Contains(stage)).Order(StringComparer.Ordinal)];
    }

    /// <summary>A column's cards: flagged first, then by id. The parking lot keeps the operator's own order instead.</summary>
    public static IReadOnlyList<CardSummary> Sorted(string stage, IEnumerable<CardSummary> cards) =>
        stage == ParkingLot
            ? [.. cards.OrderBy(card => card.Position ?? long.MaxValue).ThenBy(card => card.Id, StringComparer.Ordinal)]
            : [.. cards.OrderByDescending(card => card.NeedsHuman).ThenBy(card => card.Id, StringComparer.Ordinal)];

    /// <summary>The filter box: a card's id or title holding the text, in any case. Nothing typed matches everything.</summary>
    public static bool Matches(CardSummary card, string? filter)
    {
        ArgumentNullException.ThrowIfNull(card);

        var query = filter?.Trim();
        return string.IsNullOrEmpty(query)
            || card.Id.Contains(query, StringComparison.OrdinalIgnoreCase)
            || card.Title.Contains(query, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The count over the board, which names the whole only while something is hiding part of it.</summary>
    public static string CountLabel(int shown, int total, bool filtering) => filtering ? $"{shown} of {total} cards" : $"{total} cards";

    /// <summary>A split origin's progress, or none for a card with no pieces. `cards` is the whole board, not what a filter left.</summary>
    public static SplitProgress? Split(CardSummary card, IReadOnlyCollection<CardSummary> cards)
    {
        ArgumentNullException.ThrowIfNull(card);

        var pieces = cards.Where(piece => piece.SplitFrom == card.Id).ToList();
        return pieces.Count == 0 ? null : new SplitProgress(pieces.Count(piece => piece.Stage == Merged), pieces.Count);
    }

    /// <summary>
    /// What still blocks a card. A dependency the board cannot find counts as unfinished, never as
    /// fine. A split origin counts as finished once it has pieces and all of them are.
    /// </summary>
    public static IReadOnlyList<string> UnfinishedDeps(CardSummary card, IReadOnlyCollection<CardSummary> cards)
    {
        ArgumentNullException.ThrowIfNull(card);

        var byId = cards.ToDictionary(other => other.Id);
        bool Finished(string id)
        {
            if (!byId.TryGetValue(id, out var dep))
            {
                return false;
            }

            if (dep.Stage == Merged)
            {
                return true;
            }

            var pieces = cards.Where(piece => piece.SplitFrom == id).ToList();
            return pieces.Count > 0 && pieces.All(piece => Finished(piece.Id));
        }

        return [.. card.DependsOn.Where(id => !Finished(id))];
    }

    /// <summary>The events that change nothing a card summary carries. Named rather than matched, so an event type added later still reloads.</summary>
    public static bool IsToolType(string type) => type is "tool.executed" or "tool.denied" or "tool.unguarded";

    /// <summary>Whether a feed event changes what the board shows. Anything unreadable does, which is safe.</summary>
    public static bool IsToolEvent(string data) => Read(data, "message") is { } type && IsToolType(type);

    /// <summary>
    /// A tile's last-event line shows only while a card's latest event is its dispatch or a tool call
    /// in the stage it is in now: naming another stage means the card has moved on since.
    /// </summary>
    public static bool ShowsLastEvent(CardActivity? activity, string stage) =>
        activity is not null && activity.Stage == stage && (activity.Type == "stage.dispatched" || activity.Type.StartsWith("tool.", StringComparison.Ordinal));

    /// <summary>"3d in stage". Minutes, hours or days, as the web board rounds them.</summary>
    public static string AgeInStage(DateTimeOffset entered, DateTimeOffset now)
    {
        var elapsed = Elapsed(entered, now);
        return elapsed < TimeSpan.FromHours(1) ? $"{Rounded(elapsed.TotalMinutes)}m in stage"
            : elapsed < TimeSpan.FromDays(1) ? $"{Rounded(elapsed.TotalHours)}h in stage"
            : $"{Rounded(elapsed.TotalDays)}d in stage";
    }

    /// <summary>"20s ago". Seconds for the first minute, because a tile ticks every ten seconds.</summary>
    public static string EventAge(DateTimeOffset at, DateTimeOffset now)
    {
        var elapsed = Elapsed(at, now);
        return elapsed < TimeSpan.FromMinutes(1) ? $"{Rounded(elapsed.TotalSeconds)}s ago"
            : elapsed < TimeSpan.FromHours(1) ? $"{Rounded(elapsed.TotalMinutes)}m ago"
            : elapsed < TimeSpan.FromDays(1) ? $"{Rounded(elapsed.TotalHours)}h ago"
            : $"{Rounded(elapsed.TotalDays)}d ago";
    }

    /// <summary>A feed event's card is its `correlationId` (`card.feed.listener.ts`).</summary>
    public static string? FeedCardId(string data) => Read(data, "correlationId");

    /// <summary>Never negative, as a clock a little behind the server's would otherwise read.</summary>
    private static TimeSpan Elapsed(DateTimeOffset from, DateTimeOffset now) => now > from ? now - from : TimeSpan.Zero;

    private static long Rounded(double value) => (long)Math.Round(value, MidpointRounding.AwayFromZero);

    private static string? Read(string data, string field)
    {
        try
        {
            using var document = JsonDocument.Parse(data);
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty(field, out var value)
                && value.ValueKind == JsonValueKind.String
                    ? value.GetString()
                    : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
