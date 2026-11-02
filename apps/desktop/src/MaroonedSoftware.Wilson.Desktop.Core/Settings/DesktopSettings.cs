using System.Text.Json;
using System.Text.Json.Serialization;

namespace MaroonedSoftware.Wilson.Desktop.Core.Settings;

/// <summary>What is remembered between launches that is not a secret: which server, which project and chat on it, and how the app looks.</summary>
public sealed record DesktopSettings
{
    public string? Origin { get; init; }

    public string? Project { get; init; }

    /// <summary>The chat left open, so a launch reopens the conversation. None is a new chat.</summary>
    public string? Thread { get; init; }

    /// <summary>Written by name, so the file stays readable and a reordered enum cannot change it.</summary>
    [JsonConverter(typeof(JsonStringEnumConverter<Appearance>))]
    public Appearance Appearance { get; init; }

    /// <summary>The columns folded away on each project's board.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> Collapsed { get; init; } = new Dictionary<string, IReadOnlyList<string>>();

    /// <summary>The chat docked beside a page.</summary>
    public ChatDock Dock { get; init; } = new();

    /// <summary>`~/Library/Application Support/Wilson/settings.json`.</summary>
    public static string DefaultPath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Wilson", "settings.json");

    /// <summary>The file's settings. A missing or unreadable file is a first run, not a failure to start.</summary>
    public static DesktopSettings Load(string path)
    {
        try
        {
            return JsonSerializer.Deserialize<DesktopSettings>(File.ReadAllText(path)) ?? new DesktopSettings();
        }
        catch (Exception failure) when (failure is IOException or UnauthorizedAccessException or JsonException)
        {
            return new DesktopSettings();
        }
    }

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this));
    }
}
