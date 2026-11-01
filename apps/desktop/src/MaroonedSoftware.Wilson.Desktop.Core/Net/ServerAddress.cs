using System.Text.RegularExpressions;

namespace MaroonedSoftware.Wilson.Desktop.Core.Net;

/// <summary>Reading a typed or pasted server address into a bare origin.</summary>
/// <remarks>
/// The Android app's `ServerUrl`, with one deliberate difference: plain http is always allowed,
/// because a board on a home server such as Tower is served that way (PROJECT.md, Deployment), and a
/// dotless name is assumed to be http for the reason an IP is: neither has a certificate to offer.
/// </remarks>
public static partial class ServerAddress
{
    /// <summary>The origin (scheme, host, any port, no trailing slash), or null when it is not an address.</summary>
    public static string? Parse(string? text)
    {
        var trimmed = SpaceBesideSeparator().Replace(text?.Trim() ?? string.Empty, "$1").TrimEnd('/');
        if (trimmed.Length == 0 || trimmed.Any(char.IsWhiteSpace))
        {
            return null;
        }

        // `http:/host` is a slipped slash, not a host called http.
        var hasScheme = trimmed.Contains("://", StringComparison.Ordinal);
        if (!hasScheme && trimmed.Contains(":/", StringComparison.Ordinal))
        {
            return null;
        }

        var assumed = NoCertificate().IsMatch(trimmed) ? "http" : "https";
        if (!Uri.TryCreate(hasScheme ? trimmed : $"{assumed}://{trimmed}", UriKind.Absolute, out var uri))
        {
            return null;
        }

        // A user or password is refused outright: an address names a place, never a way in.
        if (uri.Scheme is not ("http" or "https") || uri.UserInfo.Length > 0 || uri.Host.Length == 0)
        {
            return null;
        }

        return uri.IsDefaultPort ? $"{uri.Scheme}://{uri.Host}" : $"{uri.Scheme}://{uri.Host}:{uri.Port}";
    }

    /// <summary>A space a keyboard or a paste left beside a separator.</summary>
    [GeneratedRegex(@"\s*([.:/])\s*")]
    private static partial Regex SpaceBesideSeparator();

    /// <summary>A bare IPv4 address or a dotless name, with any port or path.</summary>
    [GeneratedRegex(@"^(\d{1,3}(\.\d{1,3}){3}|[^./:]+)(:\d+)?(/.*)?$")]
    private static partial Regex NoCertificate();
}
