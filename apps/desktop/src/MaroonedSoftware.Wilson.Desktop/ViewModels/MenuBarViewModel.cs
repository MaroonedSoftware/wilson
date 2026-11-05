using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.MenuBar;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>A ring: how full, what to print in it, and what it is. A share with nothing behind it prints a dash.</summary>
public sealed record MenuBarRing(string Label, string Value, double Sweep, string Detail)
{
    private const double FullTurn = 360;

    public static MenuBarRing Of(string label, int? percent, string detail, string? value = null) =>
        new(label, value ?? (percent is { } known ? $"{known}%" : "–"), (percent ?? 0) * FullTurn / 100, detail);
}

/// <summary>One line of label and figure.</summary>
public sealed record MenuBarRow(string Label, string Value, bool Warns = false);

/// <summary>An engine account in the panel: how it stands beside its name, and what it spent under it.</summary>
public sealed record MenuBarAccountRow(string Name, string Status, bool Limited, string? Spend);

/// <summary>A day's bar, in pixels, with its figures in the tip.</summary>
public sealed record MenuBarBar(double Height, string Tip, bool Today);

/// <summary>A project in the panel, which opens its board.</summary>
public sealed record MenuBarProjectRow(string Name, string Detail, bool Flagged, MenuBarViewModel Panel);

/// <summary>
/// What the menu bar icon drops down: a summary of every project on this server. It reads only while it is
/// open, because the stats are summed from the event log on each request.
/// </summary>
public sealed partial class MenuBarViewModel(ShellViewModel shell, Action reveal, Action quit) : PageViewModel
{
    /// <summary>Long enough to see a trend without being a whole month of bars in a narrow panel.</summary>
    public const int WindowDays = 14;

    private const double BarHeight = 44;
    private const double ShortestBar = 2;
    private static readonly TimeSpan Reading = TimeSpan.FromSeconds(15);

    public ObservableCollection<MenuBarBar> Bars { get; } = [];

    public ObservableCollection<MenuBarRow> Today { get; } = [];

    public ObservableCollection<MenuBarProjectRow> Projects { get; } = [];

    public ObservableCollection<MenuBarRow> Hosts { get; } = [];

    public ObservableCollection<MenuBarAccountRow> Accounts { get; } = [];

    /// <summary>Which server this is about, as more than one can be signed in to over time.</summary>
    [ObservableProperty]
    private string? _server;

    [ObservableProperty]
    private bool _draining;

    /// <summary>Nothing to read without a session. The panel still opens the app and quits it.</summary>
    [ObservableProperty]
    private bool _signedOut;

    [ObservableProperty]
    private bool _hasFigures;

    [ObservableProperty]
    private string? _error;

    [ObservableProperty]
    private MenuBarRing _slots = MenuBarRing.Of("Slots", null, "Slots in use");

    [ObservableProperty]
    private MenuBarRing _passed = MenuBarRing.Of("Passed", null, $"Attempts that moved a card forward, last {WindowDays} days");

    [ObservableProperty]
    private MenuBarRing _cached = MenuBarRing.Of("Cached", null, $"Input tokens read from cache, last {WindowDays} days");

    [ObservableProperty]
    private string? _historyLine;

    [ObservableProperty]
    private bool _hasHosts;

    [ObservableProperty]
    private bool _hasAccounts;

    [RelayCommand]
    public void OpenWilson() => reveal();

    [RelayCommand]
    public void Quit() => quit();

    [RelayCommand]
    public void OpenProject(string project)
    {
        shell.ShowProject(project);
        reveal();
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await ReadAsync(cancellationToken);
            await Task.Delay(Reading, cancellationToken);
        }
    }

    private async Task ReadAsync(CancellationToken cancellationToken)
    {
        if (shell.Connection is not { } connection || !shell.SignedIn)
        {
            SignedOut = true;
            HasFigures = false;
            Server = null;
            Error = null;
            return;
        }

        SignedOut = false;
        Server = new Uri(connection.Origin).Host;
        try
        {
            var names = (await connection.Sdk.Projects.ListProjectsAsync(cancellationToken)).Select(project => project.Name).ToList();
            var drain = Optional(connection.Sdk.Settings.GetDrainStatusAsync(cancellationToken));
            var hosts = Optional(connection.Sdk.Hosts.ListHostsAsync(cancellationToken));
            var local = Optional(connection.Sdk.Settings.GetLocalStageSlotsAsync(cancellationToken));
            var limits = Optional(connection.Sdk.EngineTokens.ListEngineLimitsAsync(cancellationToken));
            var tokens = Optional(connection.Sdk.EngineTokens.ListEngineTokensAsync(cancellationToken));
            var spend = Optional(connection.Sdk.EngineTokens.ListEngineAccountUsageAsync(new EngineAccountUsageQuery { Days = WindowDays }, cancellationToken));
            var projects = await Task.WhenAll(names.Select(name => ReadProjectAsync(name, cancellationToken)));
            var read = projects.OfType<MenuBarProjectReading>().ToList();

            Show(MenuBarStats.Figures(new MenuBarReading(read, await drain, await hosts, await local, await limits, await tokens, await spend, WindowDays), DateTimeOffset.UtcNow));
            var missing = names.Except(read.Select(project => project.Name), StringComparer.Ordinal).ToList();
            Error = missing.Count > 0 ? $"Could not read {string.Join(", ", missing)}" : null;
        }
        catch (HttpRequestException failure)
        {
            // What was read last stays up, as it is still the best there is, under a line saying it is old.
            Error = $"Could not refresh: {ApiError.Reason(failure)}";
        }
    }

    private async Task<MenuBarProjectReading?> ReadProjectAsync(string name, CancellationToken cancellationToken)
    {
        try
        {
            using var sdk = shell.Connection!.ForProject(name);
            var query = new ProjectStatsQuery { Days = WindowDays };
            var stats = sdk.Board.GetProjectStatsAsync(query, cancellationToken);
            var gates = sdk.Board.GetProjectGateStatsAsync(query, cancellationToken);
            var cards = sdk.Board.ListCardsAsync(cancellationToken);
            return new MenuBarProjectReading(name, await stats, await gates, await cards);
        }
        catch (HttpRequestException failure)
        {
            Trace.WriteLine($"menu bar: {name}: {failure.Message}");
            return null;
        }
    }

    /// <summary>A key that may not read something simply shows nothing of it.</summary>
    private static async Task<T?> Optional<T>(Task<T> read)
        where T : class
    {
        try
        {
            return await read;
        }
        catch (HttpRequestException failure)
        {
            Trace.WriteLine($"menu bar: {failure.Message}");
            return null;
        }
    }

    private void Show(MenuBarFigures figures)
    {
        HasFigures = true;
        Draining = figures.Draining;
        Slots = MenuBarRing.Of(
            "Slots",
            figures.SlotsPercent,
            figures.Capacity is { } capacity ? $"{figures.Running ?? 0} running of {capacity} slots" : "Slots in use",
            figures.SlotsPercent is null ? figures.Running?.ToString(CultureInfo.CurrentCulture) : null);
        Passed = MenuBarRing.Of("Passed", figures.PassedPercent, Passed.Detail);
        Cached = MenuBarRing.Of("Cached", figures.CachedPercent, Cached.Detail);

        Replace(Bars, figures.Days.Select((day, index) => Bar(day, index == figures.Days.Count - 1)));
        HistoryLine = $"{MenuBarStats.Compact(figures.Days.Sum(day => day.OutputTokens))} output, last {WindowDays} days";

        Replace(Today, DetailRows(figures));
        Replace(Projects, figures.Projects.Select(project => new MenuBarProjectRow(project.Name, ProjectDetail(project), project.Flagged > 0, this)));
        Replace(Hosts, figures.Hosts.Select(host => new MenuBarRow(host.State == "enabled" ? host.Name : $"{host.Name} ({host.State})", $"{host.Used} of {host.Slots}")));
        Replace(Accounts, figures.Accounts.Select(account => new MenuBarAccountRow(account.Name, account.Status, account.Limited, account.Spend)));
        HasHosts = Hosts.Count > 0;
        HasAccounts = Accounts.Count > 0;
    }

    private static IEnumerable<MenuBarRow> DetailRows(MenuBarFigures figures)
    {
        if (figures.Running is { } running)
        {
            yield return new MenuBarRow("Running", Count(running));
        }

        if (figures.Held is { } held)
        {
            yield return new MenuBarRow("Waiting", Count(held));
        }

        yield return new MenuBarRow("Needs human", Count(figures.NeedsHuman), figures.NeedsHuman > 0);
        yield return new MenuBarRow("Output tokens today", MenuBarStats.Compact(figures.OutputToday));
        yield return new MenuBarRow("Input tokens today", MenuBarStats.Compact(figures.InputToday));
        yield return new MenuBarRow("Attempts today", figures.FailedToday > 0 ? $"{Count(figures.AttemptsToday)} ({Count(figures.FailedToday)} failed)" : Count(figures.AttemptsToday), figures.FailedToday > 0);
    }

    private static MenuBarBar Bar(MenuBarDay day, bool today) => new(
        day.OutputTokens > 0 ? Math.Max(ShortestBar, day.Share * BarHeight) : 0,
        $"{day.Date}: {Count(day.OutputTokens)} output, {Count(day.InputTokens)} input, {Count(day.Attempts)} attempts, {Count(day.Failed)} failed",
        today);

    private static string ProjectDetail(MenuBarProjectLine project)
    {
        var parts = new List<string>();
        if (project.Running > 0)
        {
            parts.Add($"{Count(project.Running)} running");
        }

        if (project.Flagged > 0)
        {
            parts.Add($"{Count(project.Flagged)} flagged");
        }

        parts.Add($"{MenuBarStats.Compact(project.OutputToday)} today");
        return string.Join(", ", parts);
    }

    private static string Count(long value) => value.ToString("N0", CultureInfo.CurrentCulture);

    /// <summary>In place, so a re-read does not lose the scroll or a tip being read.</summary>
    private static void Replace<T>(ObservableCollection<T> rows, IEnumerable<T> next)
    {
        var fresh = next.ToList();
        for (var index = 0; index < fresh.Count; index++)
        {
            if (index >= rows.Count)
            {
                rows.Add(fresh[index]);
            }
            else if (!EqualityComparer<T>.Default.Equals(rows[index], fresh[index]))
            {
                rows[index] = fresh[index];
            }
        }

        while (rows.Count > fresh.Count)
        {
            rows.RemoveAt(rows.Count - 1);
        }
    }
}
