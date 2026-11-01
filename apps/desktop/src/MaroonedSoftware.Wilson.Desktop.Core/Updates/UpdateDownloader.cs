using System.Diagnostics;

namespace MaroonedSoftware.Wilson.Desktop.Core.Updates;

/// <summary>Fetches a release and keeps it only if its signature holds.</summary>
public sealed class UpdateDownloader(HttpClient http, string publicKey, string directory)
{
    /// <summary>Far larger than a release, so a bad answer cannot fill the disk.</summary>
    private const long MaxBytes = 300 * 1024 * 1024;

    /// <summary>The verified zip's path, or null. Every failure answers null: the notice still stands.</summary>
    public async Task<string?> DownloadAsync(UpdateAvailable update, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(update);

        if (update is not { Zip: { } zipUrl, Signature: { } signatureUrl } || !IsHttps(zipUrl) || !IsHttps(signatureUrl))
        {
            return null;
        }

        Directory.CreateDirectory(directory);
        var zip = Path.Combine(directory, $"wilson-{update.Version}.zip");
        try
        {
            var signature = await http.GetByteArrayAsync(new Uri(signatureUrl), cancellationToken).ConfigureAwait(false);
            await SaveAsync(new Uri(zipUrl), zip, cancellationToken).ConfigureAwait(false);

            await using var saved = File.OpenRead(zip);
            if (UpdateSignature.IsValid(publicKey, update.Version, UpdateSignature.Hash(saved), signature))
            {
                return zip;
            }

            Trace.WriteLine($"updates: {update.Version} failed its signature check");
        }
        catch (Exception failure) when (failure is HttpRequestException or IOException or TaskCanceledException or InvalidOperationException)
        {
            Trace.WriteLine($"updates: could not download {update.Version}: {failure.Message}");
        }

        File.Delete(zip);
        return null;
    }

    private static bool IsHttps(string url) => Uri.TryCreate(url, UriKind.Absolute, out var parsed) && parsed.Scheme == Uri.UriSchemeHttps;

    private async Task SaveAsync(Uri url, string path, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();

        await using var body = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using var file = File.Create(path);
        var buffer = new byte[81920];
        var total = 0L;
        while (await body.ReadAsync(buffer, cancellationToken).ConfigureAwait(false) is > 0 and var read)
        {
            total += read;
            if (total > MaxBytes)
            {
                throw new InvalidOperationException("the download is too large to be a release");
            }

            await file.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
        }
    }
}
