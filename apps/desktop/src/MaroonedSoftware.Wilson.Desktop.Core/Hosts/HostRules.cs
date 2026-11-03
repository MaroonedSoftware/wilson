using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Hosts;

/// <summary>What `routes/hosts.tsx` says about a host, kept in step by hand.</summary>
public static class HostRules
{
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
