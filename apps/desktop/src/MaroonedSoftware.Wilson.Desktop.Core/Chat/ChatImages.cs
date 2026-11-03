namespace MaroonedSoftware.Wilson.Desktop.Core.Chat;

/// <summary>What the chat takes as an image, the same rules as the API's <c>chat.attachment.service.ts</c>, so most refusals are said before an upload.</summary>
public static class ChatImages
{
    public const string Png = "image/png";

    /// <summary>The API's limit on one image.</summary>
    public const int MaxBytes = 3_932_160;

    /// <summary>The API's limit on one message.</summary>
    public const int MaxPerMessage = 5;

    /// <summary>The longest edge worth sending: a model scales anything larger down itself.</summary>
    public const int MaxEdge = 1568;

    /// <summary>The longest edge an image is scaled to before it is called too large.</summary>
    public const int SmallestEdge = 256;

    /// <summary>The largest file read at all, generous for a photo, so a picked video does not fill memory.</summary>
    public const long MaxFileBytes = 64L * 1024 * 1024;

    /// <summary>The image type these bytes are, by their first bytes alone, or null for anything else.</summary>
    public static string? TypeOf(ReadOnlySpan<byte> bytes)
    {
        if (bytes.StartsWith<byte>([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        {
            return Png;
        }

        if (bytes.StartsWith<byte>([0xff, 0xd8, 0xff]))
        {
            return "image/jpeg";
        }

        if (bytes.StartsWith<byte>([0x47, 0x49, 0x46, 0x38]))
        {
            return "image/gif";
        }

        return bytes.StartsWith<byte>([0x52, 0x49, 0x46, 0x46]) && bytes.Length >= 12 && bytes[8..12].SequenceEqual<byte>([0x57, 0x45, 0x42, 0x50])
            ? "image/webp"
            : null;
    }

    public static bool NeedsScaling(long bytes, int width, int height) => bytes > MaxBytes || Math.Max(width, height) > MaxEdge;

    /// <summary>The size with its longest edge at most <paramref name="edge"/>, keeping its shape and never reaching zero.</summary>
    public static (int Width, int Height) Fit(int width, int height, int edge)
    {
        var longest = Math.Max(width, height);
        if (longest <= edge)
        {
            return (width, height);
        }

        var scale = (double)edge / longest;
        return (Math.Max(1, (int)Math.Round(width * scale)), Math.Max(1, (int)Math.Round(height * scale)));
    }

    /// <summary>The name of a file that has become a PNG.</summary>
    public static string AsPng(string filename) => $"{Path.GetFileNameWithoutExtension(filename)}.png";
}
