using System.Text.Json;

namespace MaroonedSoftware.Wilson.Desktop.Core.Settings;

/// <summary>What is remembered between launches that is not a secret: which server, and which project and chat on it.</summary>
public sealed record DesktopSettings
{
    public string? Origin { get; init; }

    public string? Project { get; init; }

    /// <summary>The chat left open, so a launch reopens the conversation. None is a new chat.</summary>
    public string? Thread { get; init; }

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
