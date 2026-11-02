using System.Text.Json;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Board;

/// <summary>One tool call on a card's page: the tool as recorded, and a short label if the event has one.</summary>
public sealed record ToolRow(string Tool, string Label, DateTimeOffset At);

/// <summary>A card's tool calls, as `LiveActivity.tsx` draws them.</summary>
public static class ToolRows
{
    /// <summary>
    /// Newest first: the feed's calls over the fetched events' tail, so a page opened mid-run is not
    /// empty. Connecting can replay the very event the tail ends on, and the two share no id, so a
    /// live event matching the tail's newest type at the same instant is dropped.
    /// </summary>
    public static IReadOnlyList<ToolRow> Merge(IEnumerable<CardEvent> seed, IEnumerable<FeedToolEvent> live)
    {
        var tail = seed.Where(entry => entry.Type.StartsWith("tool.", StringComparison.Ordinal)).ToList();
        var newest = tail.Count > 0 ? tail[^1] : null;
        var fresh = live.Where(entry => !(newest is not null && entry.Ts == newest.CreatedAt && entry.Type == newest.Type));

        return
        [
            .. fresh.Select(entry => Row(entry.Type, entry.Payload, entry.Ts))
                .Concat(Enumerable.Reverse(tail).Select(entry => Row(entry.Type, entry.Payload, entry.CreatedAt)))
                .Take(CardFeedLog.MostToolEvents),
        ];
    }

    private static ToolRow Row(string type, JsonElement payload, DateTimeOffset at) =>
        new(Text(payload, "tool") ?? "tool", Label(type, payload), at);

    /// <summary>A denial's reason, or the command, or the path, whichever the tool recorded.</summary>
    private static string Label(string type, JsonElement payload) =>
        (type == "tool.denied" ? Text(payload, "reason") : null) ?? Text(payload, "command") ?? Text(payload, "path") ?? string.Empty;

    /// <summary>Read defensively, as nothing upstream holds a payload to a shape.</summary>
    private static string? Text(JsonElement payload, string field) =>
        payload.ValueKind == JsonValueKind.Object
        && payload.TryGetProperty(field, out var value)
        && value.ValueKind == JsonValueKind.String
        && value.GetString() is { Length: > 0 } text
            ? text
            : null;
}
