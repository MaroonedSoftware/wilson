using System.Globalization;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Hosts;

/// <summary>What `routes/hosts.tsx` says about a host, kept in step by hand.</summary>
public static class HostRules
{
    private const double GiB = 1024d * 1024d * 1024d;
    private const double LowDiskShare = 0.1;

    /// <summary>"in 3h 12m", "5m ago": how far `at` is from `now`, to the minute.</summary>
    public static string Relative(DateTimeOffset at, DateTimeOffset now)
    {
        var minutes = (long)Math.Floor(((at - now).TotalMinutes) + 0.5);
        var span = Math.Abs(minutes);
        var text = span switch
        {
            < 1 => "less than a minute",
            < 60 => $"{span}m",
            _ => $"{span / 60}h {span % 60}m",
        };
        return at >= now ? $"in {text}" : $"{text} ago";
    }

    /// <summary>Whether a host takes new stages, and if not, which switch says so.</summary>
    public static string State(Host host)
    {
        ArgumentNullException.ThrowIfNull(host);

        return !host.Enabled ? "disabled" : host.Draining ? "draining" : "enabled";
    }

    /// <summary>The last probe's verdict.</summary>
    public static string Probe(Host host, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(host);

        return host.Probe is { } probe ? $"{(probe.Ok ? "probe ok" : "probe failed")} {Relative(probe.ProbedAt, now)}" : "never probed";
    }

    /// <summary>Whether a worker is connected now, where <see cref="Probe"/> is only what was last found. An SSH host keeps no connection to report.</summary>
    public static string? Connection(Host host, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(host);

        if (host.Kind != HostKind.Worker)
        {
            return null;
        }

        return host.Connection is { } connection ? $"connected {Relative(connection.Since, now)}" : "not connected";
    }

    /// <summary>The line under a host's name: how it is reached, and what is known of it.</summary>
    public static string Summary(Host host, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(host);

        var reached = host.Connection is { } connection ? $"worker {connection.WorkerVersion} on {connection.Platform}" : "worker";
        var parts = new List<string> { host.Kind == HostKind.Worker ? reached : $"ssh {host.SshTarget}" };
        if (host.Kind == HostKind.Worker)
        {
            parts.Add(host.WorkerToken is { } token ? $"token …{token.Hint}" : "no token yet");
        }

        if (host.Probe?.EngineVersion is { Length: > 0 } version)
        {
            parts.Add($"claude {version}");
        }

        if (host.Probe?.ExpiresAt is { } expires)
        {
            parts.Add($"expires {Relative(expires, now)}");
        }
        else if (host.LifetimeMinutes is { } lifetime and not 0)
        {
            parts.Add($"lives {lifetime}m after boot");
        }

        if (host.CommandEnv.Count > 0)
        {
            parts.Add($"commands get {string.Join(", ", host.CommandEnv)} from it");
        }

        return string.Join(" · ", parts);
    }

    /// <summary>Why there is no reading of the machine to show, or null when there is one.</summary>
    public static string? MachineNote(Host host)
    {
        ArgumentNullException.ThrowIfNull(host);

        if (host.Kind != HostKind.Worker)
        {
            return "Not reported for an SSH host.";
        }

        return host.Connection is null ? "No reading while its worker is not connected."
            : host.Connection.Metrics is null ? "No reading yet."
            : null;
    }

    /// <summary>"load 2.3 on 12 cores · 18.2 of 32.0 GiB memory used · up 3d 4h".</summary>
    public static string Machine(HostMetrics metrics)
    {
        ArgumentNullException.ThrowIfNull(metrics);

        var used = metrics.MemoryTotalBytes - metrics.MemoryFreeBytes;
        var load = metrics.LoadAverage.ToString("F1", CultureInfo.InvariantCulture);
        var cores = metrics.Cpus == 1 ? "1 core" : $"{metrics.Cpus} cores";
        return $"load {load} on {cores} · {Gib(used)} of {Gib(metrics.MemoryTotalBytes)} GiB memory used · up {Uptime(metrics.UptimeSeconds)}";
    }

    /// <summary>"/srv/projects: 120.5 of 500.0 GiB free".</summary>
    public static string Disk(HostDisk disk)
    {
        ArgumentNullException.ThrowIfNull(disk);

        return $"{disk.Path}: {Gib(disk.FreeBytes)} of {Gib(disk.TotalBytes)} GiB free";
    }

    /// <summary>A stage cuts a worktree and builds there, so a volume nearly full is worth a colour before it fails one.</summary>
    public static bool DiskLow(HostDisk disk)
    {
        ArgumentNullException.ThrowIfNull(disk);

        return disk.FreeBytes < disk.TotalBytes * LowDiskShare;
    }

    private static string Gib(long bytes) => (bytes / GiB).ToString("F1", CultureInfo.InvariantCulture);

    private static string Uptime(long seconds)
    {
        var (minutes, hours, days) = (seconds / 60 % 60, seconds / 3600 % 24, seconds / 86400);
        return days > 0 ? $"{days}d {hours}h" : hours > 0 ? $"{hours}h {minutes}m" : $"{minutes}m";
    }

    /// <summary>How a run ended, in a word or two. "No word" is a run nothing ever said the end of, such as a daemon killed during it.</summary>
    public static string Outcome(HostRun run)
    {
        ArgumentNullException.ThrowIfNull(run);

        return run.Outcome switch
        {
            HostRunOutcome.Running => "running",
            HostRunOutcome.Passed => "passed",
            HostRunOutcome.Failed => "failed",
            HostRunOutcome.Lost => "host lost",
            HostRunOutcome.Interrupted => "interrupted",
            HostRunOutcome.Abandoned => "abandoned",
            _ => "no word",
        };
    }

    /// <summary>"implementing · 14m, ended 2h 3m ago", or when it started while there is no end to say.</summary>
    public static string RunDetail(HostRun run, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(run);

        if (run.EndedAt is not { } ended)
        {
            return $"{run.Stage} · started {Relative(run.StartedAt, now)}";
        }

        var minutes = (long)Math.Floor((ended - run.StartedAt).TotalMinutes + 0.5);
        var took = minutes switch
        {
            < 1 => "under a minute",
            < 60 => $"{minutes}m",
            _ => $"{minutes / 60}h {minutes % 60}m",
        };
        return $"{run.Stage} · {took}, ended {Relative(ended, now)}";
    }

    public static string Slots(Host host)
    {
        ArgumentNullException.ThrowIfNull(host);

        return $"{host.Running.Count} of {host.Slots} slot{(host.Slots == 1 ? string.Empty : "s")} in use";
    }

    /// <summary>A registration from the form: only what was filled in, so the server's defaults stand for the rest.</summary>
    public static CreateHostRequest Registration(string name, bool worker, string? sshTarget, long? slots, long? lifetimeMinutes, string? commandEnv)
    {
        ArgumentNullException.ThrowIfNull(name);

        var env = (commandEnv ?? string.Empty).Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        return new CreateHostRequest
        {
            Name = name.Trim(),
            Kind = worker ? CreateHostRequestKind.Worker : null,
            SshTarget = !worker && !string.IsNullOrWhiteSpace(sshTarget) ? sshTarget.Trim() : null,
            Slots = slots,
            LifetimeMinutes = lifetimeMinutes,
            CommandEnv = env.Length > 0 ? [.. env] : null,
        };
    }
}
