using System.Text.Json;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Board;

/// <summary>What the board decides without a window. The same rules as the web board and the Android app.</summary>
public static class BoardRules
{
    public const string ParkingLot = "parking-lot";

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

    /// <summary>Whether a feed event changes what the board shows. Anything unreadable does, which is safe.</summary>
    public static bool IsToolEvent(string data) => Read(data, "message")?.StartsWith("tool.", StringComparison.Ordinal) == true;

    /// <summary>A feed event's card is its `correlationId` (`card.feed.listener.ts`).</summary>
    public static string? FeedCardId(string data) => Read(data, "correlationId");

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
