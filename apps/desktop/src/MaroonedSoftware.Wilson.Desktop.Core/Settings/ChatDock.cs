using System.Text.Json.Serialization;

namespace MaroonedSoftware.Wilson.Desktop.Core.Settings;

/// <summary>Where the chat docks beside a page.</summary>
public enum ChatDockPosition
{
    Right,
    Bottom,
}

/// <summary>`lib/chat.dock.ts`, except that it starts open: whether the dock is open, where it sits and how big it is, so it comes back the way it was left.</summary>
public sealed record ChatDock
{
    public const int MinWidth = 320;
    public const int MaxWidth = 720;
    public const int MinHeight = 200;
    public const int MaxHeight = 640;

    /// <summary>
    /// Only a person closing it does this, so the chat follows them off the home page until then. Stored in
    /// place of an `Open`, which every older file holds as false whether or not anyone chose that.
    /// </summary>
    public bool Closed { get; init; }

    [JsonIgnore]
    public bool Open => !Closed;

    [JsonConverter(typeof(JsonStringEnumConverter<ChatDockPosition>))]
    public ChatDockPosition Position { get; init; }

    /// <summary>Docked on the right, in pixels.</summary>
    public int Width { get; init; } = 420;

    /// <summary>Docked at the bottom, in pixels.</summary>
    public int Height { get; init; } = 320;

    /// <summary>The same dock held within its limits, for a size dragged or read from a file.</summary>
    public ChatDock Held() => this with
    {
        Width = Math.Clamp(Width, MinWidth, MaxWidth),
        Height = Math.Clamp(Height, MinHeight, MaxHeight),
    };
}
