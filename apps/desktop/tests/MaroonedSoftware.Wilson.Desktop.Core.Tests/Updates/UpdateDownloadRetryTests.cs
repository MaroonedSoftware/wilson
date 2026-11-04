using MaroonedSoftware.Wilson.Desktop.Core.Updates;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Updates;

public class UpdateDownloadRetryTests
{
    private static readonly TimeSpan Wait = TimeSpan.FromHours(6);
    private static readonly DateTimeOffset Then = new(2026, 11, 4, 12, 0, 0, TimeSpan.Zero);
    private static readonly Version Failing = new(0, 3, 0);

    private static UpdateAvailable WithAssets(Version version) =>
        new(version, "https://example.com/r", "https://example.com/z", "https://example.com/s");

    private static UpdateDownloadRetry AfterAFailure()
    {
        var retry = new UpdateDownloadRetry(Wait);
        retry.Failed(WithAssets(Failing), Then);
        return retry;
    }

    [Fact]
    public void AVersionNeverAttempted_IsTried() =>
        Assert.True(new UpdateDownloadRetry(Wait).ShouldTry(Failing, Then, asked: false));

    [Fact]
    public void AFailedVersion_WaitsOutTheInterval() =>
        Assert.False(AfterAFailure().ShouldTry(Failing, Then + Wait - TimeSpan.FromSeconds(1), asked: false));

    [Fact]
    public void AFailedVersion_IsTriedOnceTheIntervalIsUp() =>
        Assert.True(AfterAFailure().ShouldTry(Failing, Then + Wait, asked: false));

    [Fact]
    public void AFailedVersion_IsTriedAtOnceWhenAsked() =>
        Assert.True(AfterAFailure().ShouldTry(Failing, Then, asked: true));

    [Fact]
    public void ANewerVersion_IsNotHeldBackByAnOlderFailure() =>
        Assert.True(AfterAFailure().ShouldTry(new Version(0, 3, 1), Then, asked: false));

    [Fact]
    public void AnotherFailure_StartsTheWaitAgain()
    {
        var retry = AfterAFailure();

        retry.Failed(WithAssets(Failing), Then + Wait);

        Assert.False(retry.ShouldTry(Failing, Then + Wait + TimeSpan.FromHours(1), asked: false));
    }

    [Theory]
    [InlineData(null, "https://example.com/s")]
    [InlineData("https://example.com/z", null)]
    public void AReleaseMissingAnAsset_DoesNotStartTheWait(string? zip, string? signature)
    {
        var retry = new UpdateDownloadRetry(Wait);

        retry.Failed(new UpdateAvailable(Failing, "https://example.com/r", zip, signature), Then);

        Assert.True(retry.ShouldTry(Failing, Then, asked: false));
    }
}
