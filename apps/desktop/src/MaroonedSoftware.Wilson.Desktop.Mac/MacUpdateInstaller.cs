using System.Diagnostics;
using MaroonedSoftware.Wilson.Desktop.Core.Updates;

namespace MaroonedSoftware.Wilson.Desktop.Mac;

/// <summary>Unpacking with `ditto`, which is what packed the release, and swapping with a script that outlives the app.</summary>
public sealed class MacUpdateInstaller : IUpdateInstaller
{
    public async Task<string?> PrepareAsync(string zip, string bundle, CancellationToken cancellationToken = default)
    {
        var staging = Path.Combine(Path.GetDirectoryName(bundle)!, $".wilson-update-{Path.GetRandomFileName()}");
        try
        {
            Directory.CreateDirectory(staging);
            if (await RunAsync("/usr/bin/ditto", ["-x", "-k", zip, staging], cancellationToken).ConfigureAwait(false)
                && await RunAsync("/usr/bin/codesign", ["--verify", "--strict", Path.Combine(staging, BundleSwap.BundleName)], cancellationToken).ConfigureAwait(false))
            {
                return staging;
            }
        }
        catch (Exception failure) when (failure is IOException or UnauthorizedAccessException)
        {
            // Most often an app the person cannot write beside. The notice's link still works.
            Trace.WriteLine($"updates: could not unpack: {failure.Message}");
        }

        if (Directory.Exists(staging))
        {
            Directory.Delete(staging, recursive: true);
        }

        return null;
    }

    public void SwapAfterExit(string staging, string bundle)
    {
        var script = Path.Combine(Path.GetTempPath(), $"wilson-update-{Path.GetRandomFileName()}.sh");
        File.WriteAllText(script, BundleSwap.Script(Environment.ProcessId, bundle, staging, "/usr/bin/open"));
        using var process = Process.Start(new ProcessStartInfo("/bin/sh") { ArgumentList = { script }, UseShellExecute = false });
    }

    private static async Task<bool> RunAsync(string tool, string[] arguments, CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo(tool) { UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true };
        foreach (var argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }

        using var process = Process.Start(start);
        if (process is null)
        {
            return false;
        }

        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        return process.ExitCode == 0;
    }
}
