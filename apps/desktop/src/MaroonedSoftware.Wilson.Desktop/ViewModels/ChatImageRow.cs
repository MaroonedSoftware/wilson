using Avalonia.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using MaroonedSoftware.Wilson.Sdk.Clients;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>An image a message carries: a note until its bytes arrive, and one that stays if they never do.</summary>
public sealed partial class ChatImageRow(string filename) : ObservableObject
{
    public string Filename { get; } = filename;

    [ObservableProperty]
    private Bitmap? _picture;

    [ObservableProperty]
    private string? _note = "Loading image…";

    /// <summary>Fetches and decodes the image. A failure is the row's own note, since one image missing is no reason to fail the thread.</summary>
    public async Task LoadAsync(Func<CancellationToken, Task<FetchAChatImageResponse>> fetch)
    {
        ArgumentNullException.ThrowIfNull(fetch);

        try
        {
            var data = await fetch(CancellationToken.None) switch
            {
                FetchAChatImageResponse.ImagePng image => image.Data,
                FetchAChatImageResponse.ImageJpeg image => image.Data,
                FetchAChatImageResponse.ImageWebp image => image.Data,
                FetchAChatImageResponse.ImageGif image => image.Data,
                _ => throw new InvalidOperationException("the image answered with an unknown type"),
            };
            using var bytes = new MemoryStream(data);
            Picture = new Bitmap(bytes);
            Note = null;
        }
        catch (Exception failure) when (failure is HttpRequestException or InvalidOperationException or ArgumentException)
        {
            Note = "This image could not be loaded.";
        }
    }
}
