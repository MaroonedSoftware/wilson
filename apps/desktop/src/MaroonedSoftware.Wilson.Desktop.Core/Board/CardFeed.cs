using System.Text.Json;

namespace MaroonedSoftware.Wilson.Desktop.Core.Board;

/// <summary>The latest feed event for one card. `Ts` is its own publish time, so an event replayed on connect still shows its true age.</summary>
public sealed record CardActivity(string Type, string? Stage, JsonElement Payload, DateTimeOffset Ts);

/// <summary>A tool call from the feed. `Id` is the feed's own sequence number, not the database row's.</summary>
public sealed record FeedToolEvent(long Id, string Type, JsonElement Payload, DateTimeOffset Ts);

/// <summary>A `card` event as `card.feed.route.ts` writes it: `message` is its type, `correlationId` its card, `data` its stage and payload.</summary>
public sealed record FeedEvent(long Id, DateTimeOffset Ts, string Type, string? CardId, string? Stage, JsonElement Payload)
{
    /// <summary>The event, or none if nothing upstream kept to the shape.</summary>
    public static FeedEvent? Parse(string data)
    {
        try
        {
            using var document = JsonDocument.Parse(data);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("ts", out var ts)
                || ts.ValueKind != JsonValueKind.String
                || !ts.TryGetDateTimeOffset(out var at))
            {
                return null;
            }

            var detail = root.TryGetProperty("data", out var found) && found.ValueKind == JsonValueKind.Object ? found : default;
            return new FeedEvent(
                root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number && id.TryGetInt64(out var number) ? number : 0,
                at,
                Text(root, "message") ?? string.Empty,
                Text(root, "correlationId"),
                detail.ValueKind == JsonValueKind.Object ? Text(detail, "stage") : null,
                detail.ValueKind == JsonValueKind.Object && detail.TryGetProperty("payload", out var payload) ? payload.Clone() : default);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? Text(JsonElement element, string field) =>
        element.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}

/// <summary>
/// What a feed connection has said about each card: display state, never board state, which only a
/// re-read changes. A fresh connection starts a fresh log, because connecting replays the latest
/// event per card anyway.
/// </summary>
public sealed class CardFeedLog
{
    /// <summary>Bounded, so a long stage's tool list cannot grow without limit.</summary>
    public const int MostToolEvents = 100;

    private readonly Dictionary<string, CardActivity> _activity = [];
    private readonly Dictionary<string, List<FeedToolEvent>> _tools = [];

    public void Record(FeedEvent feedEvent)
    {
        ArgumentNullException.ThrowIfNull(feedEvent);

        if (feedEvent.CardId is not { } card)
        {
            return;
        }

        _activity[card] = new CardActivity(feedEvent.Type, feedEvent.Stage, feedEvent.Payload, feedEvent.Ts);
        if (BoardRules.IsToolType(feedEvent.Type))
        {
            if (!_tools.TryGetValue(card, out var tools))
            {
                tools = [];
                _tools[card] = tools;
            }

            tools.Insert(0, new FeedToolEvent(feedEvent.Id, feedEvent.Type, feedEvent.Payload, feedEvent.Ts));
            if (tools.Count > MostToolEvents)
            {
                tools.RemoveAt(tools.Count - 1);
            }
        }
    }

    public void Clear()
    {
        _activity.Clear();
        _tools.Clear();
    }

    public CardActivity? Activity(string card) => _activity.GetValueOrDefault(card);

    /// <summary>A card's own tool calls, newest first.</summary>
    public IReadOnlyList<FeedToolEvent> Tools(string card) => _tools.TryGetValue(card, out var tools) ? tools : [];
}
