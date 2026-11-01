using System.Diagnostics;
using MaroonedSoftware.Wilson.Desktop.Core.Updates;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Updates;

/// <summary>The script runs for real, on folders standing in for bundles, because it is the one piece that cannot be undone.</summary>
public sealed class BundleSwapTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"wilson's {Path.GetRandomFileName()}");

    private string Bundle => Path.Combine(_root, "Wilson.app");

    private string Staging => Path.Combine(_root, ".staging");

    [Theory]
    [InlineData("/Applications/Wilson.app/Contents/MacOS/wilson", "/Applications/Wilson.app")]
    [InlineData("/Users/me/bin/Debug/net10.0/wilson", null)]
    [InlineData(null, null)]
    public void OnlyABundleCanBeReplaced(string? path, string? bundle) => Assert.Equal(bundle, BundleSwap.BundleOf(path));

    [Fact]
    public async Task TheNewBundleReplacesTheOld_AndNothingIsLeftBehind()
    {
        Make(Bundle, "old");
        Make(Path.Combine(Staging, BundleSwap.BundleName), "new");

        await RunAsync();

        Assert.Equal("new", Version());
        Assert.Equal(["Wilson.app", "relaunched"], Directory.GetFileSystemEntries(_root).Select(Path.GetFileName).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task WithNothingToInstallTheOldAppStaysAndStillRelaunches()
    {
        Make(Bundle, "old");
        Directory.CreateDirectory(Staging);

        await RunAsync();

        Assert.Equal("old", Version());
        Assert.True(File.Exists(Path.Combine(_root, "relaunched")));
    }

    [Fact]
    public async Task ItWaitsForTheAppToExit()
    {
        Make(Bundle, "old");
        Make(Path.Combine(Staging, BundleSwap.BundleName), "new");
        using var running = Process.Start(new ProcessStartInfo("/bin/sleep") { ArgumentList = { "1" } })!;

        var swap = RunAsync(running.Id);
        await Task.Delay(300, TestContext.Current.CancellationToken);

        Assert.Equal("old", Version());
        await running.WaitForExitAsync(TestContext.Current.CancellationToken);
        await swap;
        Assert.Equal("new", Version());
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private static void Make(string bundle, string version)
    {
        Directory.CreateDirectory(bundle);
        File.WriteAllText(Path.Combine(bundle, "version"), version);
    }

    private string Version() => File.ReadAllText(Path.Combine(Bundle, "version"));

    private async Task RunAsync(int? processId = null)
    {
        var relaunch = Path.Combine(_root, "relaunch.sh");
        await File.WriteAllTextAsync(relaunch, $"#!/bin/sh\ntouch '{Path.Combine(_root, "relaunched").Replace("'", "'\\''", StringComparison.Ordinal)}'\n", TestContext.Current.CancellationToken);
        var script = Path.GetTempFileName();

        // A finished process's id, which nothing else is likely to hold in the moment this takes.
        var gone = processId ?? await FinishedProcessAsync();
        await File.WriteAllTextAsync(script, BundleSwap.Script(gone, Bundle, Staging, $"/bin/sh '{relaunch.Replace("'", "'\\''", StringComparison.Ordinal)}'"), TestContext.Current.CancellationToken);

        using var shell = Process.Start(new ProcessStartInfo("/bin/sh") { ArgumentList = { script } })!;
        await shell.WaitForExitAsync(TestContext.Current.CancellationToken);
        File.Delete(relaunch);
    }

    private static async Task<int> FinishedProcessAsync()
    {
        using var finished = Process.Start(new ProcessStartInfo("/usr/bin/true"))!;
        await finished.WaitForExitAsync(TestContext.Current.CancellationToken);
        return finished.Id;
    }
}
