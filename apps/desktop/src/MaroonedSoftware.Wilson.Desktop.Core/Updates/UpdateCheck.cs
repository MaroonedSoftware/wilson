using System.Reflection;
using System.Text.Json;

namespace MaroonedSoftware.Wilson.Desktop.Core.Updates;

/// <summary>A newer release. <see cref="Zip"/> and <see cref="Signature"/> are absent from one that cannot be installed here.</summary>
public sealed record UpdateAvailable(Version Version, string Page, string? Zip, string? Signature);

/// <summary>Reading GitHub's list of releases. Pure, so a list can be judged without a network.</summary>
public static class UpdateCheck
{
    public const string TagPrefix = "desktop-v";

    /// <summary>Every release, because `releases/latest` could one day answer a release of something other than this app.</summary>
    public static readonly Uri Endpoint = new("https://api.github.com/repos/MaroonedSoftware/wilson/releases?per_page=30");

    /// <summary>This build's version, as major, minor and patch.</summary>
    public static Version Current { get; } = Trimmed(Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0, 0));

    /// <summary>The newest published release above <paramref name="current"/>, if any. A tag with a suffix is a pre-release and is ignored.</summary>
    public static UpdateAvailable? Newest(Version current, string releases)
    {
        using var document = JsonDocument.Parse(releases);
        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        UpdateAvailable? newest = null;
        foreach (var release in document.RootElement.EnumerateArray())
        {
            if (Read(release, current) is { } found && found.Version > (newest?.Version ?? current))
            {
                newest = found;
            }
        }

        return newest;
    }

    private static UpdateAvailable? Read(JsonElement release, Version current)
    {
        if (release.GetProperty("draft").GetBoolean()
            || release.GetProperty("prerelease").GetBoolean()
            || release.GetProperty("tag_name").GetString() is not { } tag
            || !tag.StartsWith(TagPrefix, StringComparison.Ordinal)
            || !Version.TryParse(tag[TagPrefix.Length..], out var parsed)
            || parsed.Build < 0
            || parsed.Revision >= 0
            || parsed <= current)
        {
            return null;
        }

        var zip = $"wilson-{parsed}-osx-arm64.zip";
        return new UpdateAvailable(parsed, release.GetProperty("html_url").GetString() ?? string.Empty, Asset(release, zip), Asset(release, $"{zip}.sig"));
    }

    private static string? Asset(JsonElement release, string name) =>
        release.TryGetProperty("assets", out var assets)
            ? assets.EnumerateArray().Where(asset => asset.GetProperty("name").GetString() == name).Select(asset => asset.GetProperty("browser_download_url").GetString()).FirstOrDefault()
            : null;

    private static Version Trimmed(Version version) => new(version.Major, version.Minor, Math.Max(version.Build, 0));
}
