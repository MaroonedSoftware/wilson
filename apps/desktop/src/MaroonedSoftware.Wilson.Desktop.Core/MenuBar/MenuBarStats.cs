using System.Globalization;
using MaroonedSoftware.Wilson.Desktop.Core.Hosts;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.MenuBar;

/// <summary>One project's reads. Its stats and gate stats come from the same window, or the project is left out.</summary>
public sealed record MenuBarProjectReading(string Name, ProjectStats Stats, ProjectGateStats Gates, IReadOnlyList<CardSummary> Cards);

/// <summary>What the panel read. A server-wide read the key may not make is absent, as the header's drain status is.</summary>
public sealed record MenuBarReading(
    IReadOnlyList<MenuBarProjectReading> Projects,
    DrainStatus? Drain = null,
    IReadOnlyList<Host>? Hosts = null,
    LocalStageSlots? LocalSlots = null,
    IReadOnlyList<EngineLimit>? Limits = null);

/// <summary>One day across every project, with its bar's share of the tallest day.</summary>
public sealed record MenuBarDay(string Date, long OutputTokens, long InputTokens, long Attempts, long Failed, double Share);

public sealed record MenuBarProjectLine(string Name, int Running, int Flagged, long OutputToday);

public sealed record MenuBarHostLine(string Name, int Used, long Slots, string State);

public sealed record MenuBarLimitLine(string Account, string LimitType, string Resets);

/// <summary>The panel's figures. A percentage with nothing to be a share of is absent rather than zero.</summary>
public sealed record MenuBarFigures(
    int? Running,
    long? Capacity,
    long? Held,
    bool Draining,
    int? SlotsPercent,
    int? PassedPercent,
    int? CachedPercent,
    int NeedsHuman,
    long OutputToday,
    long InputToday,
    long AttemptsToday,
    long FailedToday,
    IReadOnlyList<MenuBarDay> Days,
    IReadOnlyList<MenuBarProjectLine> Projects,
    IReadOnlyList<MenuBarHostLine> Hosts,
    IReadOnlyList<MenuBarLimitLine> Limits);

/// <summary>The menu bar panel's sums, by the web app's `lib/stats.ts` where it has the same figure.</summary>
public static class MenuBarStats
{
    private static readonly string[] Suffixes = [string.Empty, "K", "M", "B", "T"];

    /// <summary>Adds the projects up. Days are matched by date, as every project's window is in the server's one time zone.</summary>
    public static MenuBarFigures Figures(MenuBarReading reading, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(reading);

        var days = Days(reading.Projects);
        var today = days.Count > 0 ? days[^1] : null;
        var attempts = reading.Projects.Sum(project => project.Stats.Total.Attempts);
        var passed = reading.Projects.Sum(project => PassedOutright(project.Stats.Total.Passed, project.Gates.Revised.Sum(row => row.Count)));
        var running = reading.Drain?.Running;
        var capacity = Capacity(reading.Hosts, reading.LocalSlots);

        return new MenuBarFigures(
            running?.Count,
            capacity,
            reading.Drain?.Held,
            reading.Drain?.Draining == true,
            running is not null && capacity is { } slots ? Math.Min(100, PercentOf(running.Count, slots) ?? 0) : null,
            PercentOf(passed, attempts),
            PercentOf(reading.Projects.Sum(project => project.Stats.Total.CachedInputTokens), reading.Projects.Sum(project => project.Stats.Total.InputTokens)),
            reading.Projects.Sum(project => project.Cards.Count(card => card.NeedsHuman)),
            today?.OutputTokens ?? 0,
            today?.InputTokens ?? 0,
            today?.Attempts ?? 0,
            today?.Failed ?? 0,
            days,
            [.. reading.Projects.Select(project => new MenuBarProjectLine(
                project.Name,
                running?.Count(card => card.Project == project.Name) ?? 0,
                project.Cards.Count(card => card.NeedsHuman),
                project.Stats.Days.Count > 0 ? project.Stats.Days[^1].OutputTokens : 0))],
            [.. (reading.Hosts ?? []).Select(host => new MenuBarHostLine(host.Name, host.Running.Count, host.Slots, HostRules.State(host)))],
            [.. (reading.Limits ?? [])
                .Where(limit => limit.ResetsAt > now)
                .OrderBy(limit => limit.ResetsAt)
                .Select(limit => new MenuBarLimitLine(limit.Account, limit.LimitType, HostRules.Relative(limit.ResetsAt, now)))]);
    }

    /// <summary>`part` of `whole` as a whole percentage, or nothing when there is no `whole`.</summary>
    public static int? PercentOf(long part, long whole) =>
        whole <= 0 ? null : (int)Math.Round(part * 100d / whole, MidpointRounding.AwayFromZero);

    /// <summary>
    /// Attempts that moved a card forward. A `revise` passed as a well-formed review, but sends the card back.
    /// The floor is for a window the two requests read a moment apart.
    /// </summary>
    public static long PassedOutright(long passed, long revised) => Math.Max(0, passed - revised);

    /// <summary>1,234,567 as "1.2M", where the exact figure is on the stats page.</summary>
    public static string Compact(long value)
    {
        var scaled = (double)Math.Abs(value);
        var tier = 0;
        while (tier < Suffixes.Length - 1 && Math.Round(scaled, tier == 0 ? 0 : 1, MidpointRounding.AwayFromZero) >= 1000)
        {
            scaled /= 1000;
            tier++;
        }

        var sign = value < 0 ? "-" : string.Empty;
        return $"{sign}{Math.Round(scaled, 1, MidpointRounding.AwayFromZero).ToString("0.#", CultureInfo.InvariantCulture)}{Suffixes[tier]}";
    }

    /// <summary>Slots that can take a stage now: this machine's and those of each host still taking work. Absent until both are known.</summary>
    private static long? Capacity(IReadOnlyList<Host>? hosts, LocalStageSlots? local) =>
        hosts is null || local is null ? null : local.Slots + hosts.Where(host => host.Enabled && !host.Draining).Sum(host => host.Slots);

    private static List<MenuBarDay> Days(IReadOnlyList<MenuBarProjectReading> projects)
    {
        var summed = projects
            .SelectMany(project => project.Stats.Days)
            .GroupBy(day => day.Date, StringComparer.Ordinal)
            .OrderBy(group => group.Key, StringComparer.Ordinal)
            .Select(group => (Date: group.Key, Output: group.Sum(day => day.OutputTokens), Input: group.Sum(day => day.InputTokens), Attempts: group.Sum(day => day.Attempts), Failed: group.Sum(day => day.Failed)))
            .ToList();
        var tallest = summed.Count > 0 ? summed.Max(day => day.Output) : 0;
        return [.. summed.Select(day => new MenuBarDay(day.Date, day.Output, day.Input, day.Attempts, day.Failed, tallest == 0 ? 0 : (double)day.Output / tallest))];
    }
}
