namespace MaroonedSoftware.Wilson.Desktop.Core.Auth;

/// <summary>The API's QR code is a PNG data URL, which a browser shows as it is and a window does not.</summary>
public static class DataUrl
{
    /// <summary>The bytes of a base64 data URL, or nothing for anything else.</summary>
    public static byte[]? Bytes(string? url)
    {
        const string Marker = ";base64,";
        var at = url?.IndexOf(Marker, StringComparison.Ordinal) ?? -1;
        if (at < 0 || !url!.StartsWith("data:", StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            return Convert.FromBase64String(url[(at + Marker.Length)..]);
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
