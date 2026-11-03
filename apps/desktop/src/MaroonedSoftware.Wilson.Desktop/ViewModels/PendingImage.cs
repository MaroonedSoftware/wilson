using Avalonia;
using Avalonia.Media.Imaging;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>An image in the box: what will be uploaded, and the picture of it.</summary>
public sealed record PendingImage(string Filename, string ContentType, byte[] Bytes, Bitmap Picture)
{
    /// <summary>Ready to send, or the sentence that says why it cannot be. Goes byte for byte unless it is too big, when it is scaled and becomes a PNG.</summary>
    public static (PendingImage? Image, string? Refusal) From(string filename, byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(filename);
        ArgumentNullException.ThrowIfNull(bytes);

        if (ChatImages.TypeOf(bytes) is not { } type)
        {
            return (null, $"{filename} is not a PNG, JPEG, WebP or GIF image.");
        }

        try
        {
            using var source = new MemoryStream(bytes);
            var picture = new Bitmap(source);
            var size = picture.PixelSize;
            if (!ChatImages.NeedsScaling(bytes.Length, size.Width, size.Height))
            {
                return (new PendingImage(filename, type, bytes, picture), null);
            }

            var (width, height) = ChatImages.Fit(size.Width, size.Height, ChatImages.MaxEdge);
            while (true)
            {
                var scaled = picture.CreateScaledBitmap(new PixelSize(width, height));
                using var png = new MemoryStream();
                scaled.Save(png, new PngBitmapEncoderOptions());
                if (png.Length <= ChatImages.MaxBytes)
                {
                    return (new PendingImage(ChatImages.AsPng(filename), ChatImages.Png, png.ToArray(), scaled), null);
                }

                // A noisy image can stay too large at the longest edge a model takes, so keep going down.
                if (Math.Max(width, height) < ChatImages.SmallestEdge)
                {
                    return (null, $"{filename} is too large to attach.");
                }

                (width, height) = ChatImages.Fit(width, height, Math.Max(width, height) * 3 / 4);
            }
        }
        catch (Exception failure) when (failure is ArgumentException or InvalidOperationException)
        {
            return (null, $"{filename} could not be read as an image.");
        }
    }

    /// <summary>A picture from the clipboard, which has no bytes or name of its own until it is written as a PNG.</summary>
    public static byte[] PngOf(Bitmap picture)
    {
        ArgumentNullException.ThrowIfNull(picture);

        using var png = new MemoryStream();
        picture.Save(png, new PngBitmapEncoderOptions());
        return png.ToArray();
    }
}
