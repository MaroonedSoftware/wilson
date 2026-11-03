using System.Diagnostics;
using System.Text;
using MaroonedSoftware.Wilson.Desktop.Core.Runner;

namespace MaroonedSoftware.Wilson.Desktop.Mac;

/// <summary>
/// Runs `claude setup-token` in a terminal of its own, under a config folder of its own so it cannot reuse
/// this Mac's login, and reads the token from what it prints (`CLAUDE.md`). What it prints goes nowhere
/// else: nothing here logs it, or puts it in an error.
/// </summary>
/// <param name="claude">The binary to run, or null to look for one.</param>
/// <param name="timeout">How long the person has to authorize, or null for five minutes.</param>
public sealed class MacClaudeSignIn(string? claude = null, TimeSpan? timeout = null) : IClaudeSignIn
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(5);

    private static readonly TimeSpan ShellTimeout = TimeSpan.FromSeconds(15);

    /// <summary>Sets a width no token wraps at, and becomes the binary. `$0` is the path, so nothing is quoted into the script.</summary>
    private const string InTerminal = "stty cols 400 rows 50; exec \"$0\" setup-token";

    /// <summary>Credentials that would make the command sign in as something other than the person at the browser.</summary>
    private static readonly string[] Inherited = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

    public async Task<ClaudeSignInResult> RunAsync(IProgress<string> link, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(link);

        var binary = claude ?? await FindAsync(cancellationToken).ConfigureAwait(false);
        if (binary is null || !File.Exists(binary))
        {
            return ClaudeSignInResult.Failed(ClaudeSignInFailure.NotFound);
        }

        var config = Directory.CreateTempSubdirectory("wilson-setup-token-");
        using var deadline = new CancellationTokenSource(timeout ?? DefaultTimeout);
        using var either = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, cancellationToken);
        Process? process = null;
        try
        {
            var start = new ProcessStartInfo("/usr/bin/script")
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            foreach (var argument in new[] { "-q", "/dev/null", "/bin/sh", "-c", InTerminal, binary })
            {
                start.ArgumentList.Add(argument);
            }

            foreach (var name in Inherited)
            {
                start.Environment.Remove(name);
            }

            start.Environment["CLAUDE_CONFIG_DIR"] = config.FullName;
            start.Environment["TERM"] = "xterm-256color";
            process = Process.Start(start);
            if (process is null)
            {
                return ClaudeSignInResult.Failed(ClaudeSignInFailure.NoToken);
            }

            // stderr is the same terminal, so this only stops it filling. stdin stays open, or `script` hangs up on the command.
            _ = process.StandardError.ReadToEndAsync(CancellationToken.None);
            var output = await ReadAsync(process, link, either.Token).ConfigureAwait(false);
            await process.WaitForExitAsync(either.Token).ConfigureAwait(false);
            return SetupTokenOutput.Token(output) is { } token ? ClaudeSignInResult.Succeeded(token) : ClaudeSignInResult.Failed(ClaudeSignInFailure.NoToken);
        }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            return ClaudeSignInResult.Failed(ClaudeSignInFailure.TimedOut);
        }
        finally
        {
            Stop(process);
            process?.Dispose();
            config.Delete(recursive: true);
        }
    }

    private static async Task<string> ReadAsync(Process process, IProgress<string> link, CancellationToken cancellationToken)
    {
        var output = new StringBuilder();
        var buffer = new char[4096];
        var linked = false;
        while (true)
        {
            var read = await process.StandardOutput.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                return output.ToString();
            }

            output.Append(buffer, 0, read);
            if (!linked && SetupTokenOutput.SignInLink(output.ToString()) is { } found)
            {
                linked = true;
                link.Report(found);
            }
        }
    }

    private static void Stop(Process? process)
    {
        try
        {
            if (process is { HasExited: false })
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception failure) when (failure is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            Trace.WriteLine("claude sign-in: the command had already gone");
        }
    }

    /// <summary>
    /// The usual places, then whatever the person's own shell finds, since an app opened from Finder has none
    /// of the `PATH` that nvm and the like set up there.
    /// </summary>
    private static async Task<string?> FindAsync(CancellationToken cancellationToken)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string[] usual = [Path.Combine(home, ".local/bin/claude"), Path.Combine(home, ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
        return usual.FirstOrDefault(File.Exists) ?? await FromShellAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async Task<string?> FromShellAsync(CancellationToken cancellationToken)
    {
        var shell = Environment.GetEnvironmentVariable("SHELL") is { Length: > 0 } set ? set : "/bin/zsh";
        var start = new ProcessStartInfo(shell) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in new[] { "-ilc", "command -v claude" })
        {
            start.ArgumentList.Add(argument);
        }

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(ShellTimeout);
        using var process = Process.Start(start);
        if (process is null)
        {
            return null;
        }

        try
        {
            process.StandardInput.Close();
            _ = process.StandardError.ReadToEndAsync(CancellationToken.None);
            var printed = await process.StandardOutput.ReadToEndAsync(deadline.Token).ConfigureAwait(false);
            // Startup files can print anything, so only a last line that is a real path counts.
            var last = printed.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault();
            return last is not null && Path.IsPathRooted(last) && File.Exists(last) ? last : null;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        finally
        {
            Stop(process);
        }
    }
}
