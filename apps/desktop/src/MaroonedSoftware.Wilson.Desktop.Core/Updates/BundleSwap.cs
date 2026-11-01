namespace MaroonedSoftware.Wilson.Desktop.Core.Updates;

/// <summary>Installs a verified, unpacked release in place of the running app.</summary>
public interface IUpdateInstaller
{
    /// <summary>Unpacks a verified zip beside the bundle, answering the staging folder, or null if it cannot.</summary>
    Task<string?> PrepareAsync(string zip, string bundle, CancellationToken cancellationToken = default);

    /// <summary>Starts the swap, which waits for this process to exit. The caller then quits.</summary>
    void SwapAfterExit(string staging, string bundle);
}

/// <summary>The rules of replacing a running app. Pure, except that the script is run for real in a test.</summary>
public static class BundleSwap
{
    /// <summary>The name inside a release's zip.</summary>
    public const string BundleName = "Wilson.app";

    /// <summary>The bundle a process runs from, or null when it is not one, as under `dotnet run`.</summary>
    public static string? BundleOf(string? processPath)
    {
        var macOs = Path.GetDirectoryName(processPath);
        var contents = Path.GetDirectoryName(macOs);
        return Path.GetFileName(macOs) == "MacOS" && Path.GetFileName(contents) == "Contents" && Path.GetDirectoryName(contents) is { } bundle && bundle.EndsWith(".app", StringComparison.Ordinal)
            ? bundle
            : null;
    }

    /// <summary>
    /// A shell script that waits for the app to exit, swaps the bundles and starts it again. A swap
    /// that fails puts the old app back, and the app is relaunched either way, so an update can
    /// fail to apply but cannot leave the person with no app. Staging is beside the bundle because
    /// `mv` is atomic only within a volume.
    /// </summary>
    public static string Script(int processId, string bundle, string staging, string relaunch)
    {
        var incoming = Path.Combine(staging, BundleName);
        return $"""
            #!/bin/sh
            exec >/dev/null 2>&1
            pid={processId}
            bundle={Quoted(bundle)}
            staging={Quoted(staging)}
            incoming={Quoted(incoming)}
            old="$staging.old"
            waited=0
            while kill -0 "$pid" 2>/dev/null; do
                sleep 0.2
                waited=$((waited + 1))
                if [ "$waited" -gt 150 ]; then
                    rm -rf "$staging"
                    rm -f "$0"
                    exit 1
                fi
            done
            if [ -d "$incoming" ] && mv "$bundle" "$old"; then
                if mv "$incoming" "$bundle"; then
                    rm -rf "$old"
                else
                    mv "$old" "$bundle"
                fi
            fi
            rm -rf "$staging"
            {relaunch} "$bundle"
            rm -f "$0"

            """;
    }

    private static string Quoted(string value) => $"'{value.Replace("'", "'\\''", StringComparison.Ordinal)}'";
}
