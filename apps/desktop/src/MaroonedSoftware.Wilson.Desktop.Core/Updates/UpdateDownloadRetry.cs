namespace MaroonedSoftware.Wilson.Desktop.Core.Updates;

/// <summary>
/// Spaces out attempts at a download that failed. Checks run far more often than a whole zip should be
/// fetched, and a release that fails its signature fails the same way every time.
/// </summary>
public sealed class UpdateDownloadRetry(TimeSpan wait)
{
    private Version? _failed;
    private DateTimeOffset _failedAt;

    /// <summary>
    /// Whether to attempt <paramref name="version"/> now. Someone who asked is never made to wait, and
    /// neither is a different version, which has its own zip.
    /// </summary>
    public bool ShouldTry(Version version, DateTimeOffset now, bool asked) =>
        asked || version != _failed || now - _failedAt >= wait;

    /// <summary>
    /// Notes a download that came to nothing. A release without both assets fetched nothing, so it costs
    /// nothing to look again, and the assets may yet appear.
    /// </summary>
    public void Failed(UpdateAvailable update, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(update);

        if (update is { Zip: not null, Signature: not null })
        {
            _failed = update.Version;
            _failedAt = now;
        }
    }
}
