namespace MaroonedSoftware.Wilson.Desktop.Core.Net;

/// <summary>One Server-Sent Event. <see cref="Id"/> is the last id the stream has named, to resume from.</summary>
public sealed record SseEvent(string Event, string Data, string? Id);

/// <summary>
/// Turns the lines of a `text/event-stream` into events: data lines join with newlines and a blank
/// line dispatches. Pure, so the framing is tested without a socket.
/// </summary>
public sealed class SseReader
{
    private readonly List<string> _data = [];
    private string _event = string.Empty;

    public string? LastId { get; private set; }

    /// <summary>Takes one line, answering the event it completes, if any.</summary>
    public SseEvent? Line(string line)
    {
        ArgumentNullException.ThrowIfNull(line);

        if (line.Length == 0)
        {
            var ready = _data.Count == 0 ? null : new SseEvent(_event.Length == 0 ? "message" : _event, string.Join('\n', _data), LastId);
            _event = string.Empty;
            _data.Clear();
            return ready;
        }

        var colon = line.IndexOf(':', StringComparison.Ordinal);
        if (colon == 0)
        {
            return null;
        }

        var field = colon == -1 ? line : line[..colon];
        var value = colon == -1 ? string.Empty : line[(colon + 1)..];
        if (value.StartsWith(' '))
        {
            value = value[1..];
        }

        switch (field)
        {
            case "event":
                _event = value;
                break;
            case "data":
                _data.Add(value);
                break;
            case "id" when !value.Contains('\0', StringComparison.Ordinal):
                LastId = value;
                break;
            default:
                break;
        }

        return null;
    }
}

/// <summary>What a live stream has to say: whether it is connected, and what arrived.</summary>
public abstract record StreamSignal
{
    private StreamSignal()
    {
    }

    public sealed record Live : StreamSignal;

    public sealed record Down : StreamSignal;

    public sealed record Received(SseEvent Event) : StreamSignal;

    /// <summary>Doubling from a second to thirty, so a restart is noticed quickly and an outage is not hammered.</summary>
    public static TimeSpan ReconnectDelay(int attempt) => TimeSpan.FromSeconds(Math.Min(1 << Math.Clamp(attempt, 0, 5), 30));
}
