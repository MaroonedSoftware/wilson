using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Hosts;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>
/// `routes/hosts.tsx`: the machines besides this one that stages can run on. The feed says nothing about
/// a slot being taken or a probe being recorded, so the page reads again every ten seconds.
/// </summary>
public sealed partial class HostsViewModel(ShellViewModel shell) : PageViewModel
{
    private const string Ssh = "SSH";
    private const string Worker = "Worker";
    private static readonly TimeSpan Reading = TimeSpan.FromSeconds(10);

    /// <summary>Kept by name across a read, so a form half filled in on a host survives it.</summary>
    public ObservableCollection<HostPanelViewModel> Hosts { get; } = [];

    public IReadOnlyList<string> Kinds { get; } = [Ssh, Worker];

    public ShellViewModel Shell => shell;

    [ObservableProperty]
    private string? _error;

    [ObservableProperty]
    private bool _noHosts;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanRegister))]
    private string? _name;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(OverSsh))]
    private string _kind = Ssh;

    [ObservableProperty]
    private string? _sshTarget;

    [ObservableProperty]
    private decimal? _slots = 1;

    [ObservableProperty]
    private decimal? _lifetime;

    [ObservableProperty]
    private string? _commandEnv;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanRegister))]
    private bool _registering;

    [ObservableProperty]
    private string? _registerError;

    public bool OverSsh => Kind == Ssh;

    public bool CanRegister => !Registering && !string.IsNullOrWhiteSpace(Name);

    [RelayCommand]
    public async Task RegisterAsync()
    {
        Registering = true;
        RegisterError = null;
        try
        {
            await shell.Connection!.Sdk.Hosts.RegisterHostAsync(HostRules.Registration(Name ?? string.Empty, Kind == Worker, SshTarget, (long?)Slots, (long?)Lifetime, CommandEnv));
            Name = null;
            Kind = Ssh;
            SshTarget = null;
            Slots = 1;
            Lifetime = null;
            CommandEnv = null;
            await ReadAsync(CancellationToken.None);
        }
        catch (HttpRequestException failure)
        {
            RegisterError = ApiError.Reason(failure);
        }
        finally
        {
            Registering = false;
        }
    }

    public void OpenCard(string project, string id) => shell.Push(new CardViewModel(shell, project, id));

    /// <summary>What a press on a host changed, or what changed by itself.</summary>
    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            var sdk = shell.Connection!.Sdk;
            var hosts = await sdk.Hosts.ListHostsAsync(cancellationToken);
            var runs = await Task.WhenAll(hosts.Select(host => sdk.Hosts.ListHostRunsAsync(host.Name, cancellationToken)));
            var projects = (await sdk.Projects.ListProjectsAsync(cancellationToken)).Select(project => project.Name).ToList();
            var tokens = (await sdk.EngineTokens.ListEngineTokensAsync(cancellationToken)).Select(token => token.Name).ToList();
            Draw(hosts, runs, projects, tokens);
            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load hosts: {ApiError.Reason(failure)}";
        }
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        await ReadAsync(cancellationToken);
        await EveryAsync(Reading, () => _ = ReadQuietlyAsync(cancellationToken), cancellationToken);
    }

    private async Task ReadQuietlyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await ReadAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Leaving the page is how its reading ends.
        }
    }

    private void Draw(List<Host> hosts, List<HostRun>[] runs, List<string> projects, List<string> tokens)
    {
        var now = DateTimeOffset.UtcNow;
        for (var index = Hosts.Count - 1; index >= 0; index--)
        {
            if (hosts.All(host => host.Name != Hosts[index].Name))
            {
                Hosts.RemoveAt(index);
            }
        }

        foreach (var (host, index) in hosts.Select((host, index) => (host, index)))
        {
            if (Hosts.FirstOrDefault(panel => panel.Name == host.Name) is { } panel)
            {
                panel.Draw(host, runs[index], projects, tokens, now);
            }
            else
            {
                var made = new HostPanelViewModel(shell, this, host.Name);
                made.Draw(host, runs[index], projects, tokens, now);
                Hosts.Insert(Math.Min(index, Hosts.Count), made);
            }
        }

        NoHosts = Hosts.Count == 0;
    }
}

/// <summary>A project a host serves, as drawn. It carries the panel, for its button.</summary>
public sealed record HostProjectRow(string Project, string CodeRoot, string Roots, HostPanelViewModel Panel);

/// <summary>A slot in use, as drawn.</summary>
public sealed record HostSlotRow(string Slot, string Project, string CardId, string Card, string Since, HostPanelViewModel Panel);

/// <summary>A recent run, as drawn.</summary>
public sealed record HostRunRow(string Outcome, bool Good, bool Caution, bool Bad, string Project, string CardId, string Card, string Detail, HostPanelViewModel Panel);

/// <summary>A volume, as drawn.</summary>
public sealed record HostDiskRow(string Text, bool Low);

/// <summary>One host. Every action goes through the API and the page shows what came back, so a refused write never shows as applied.</summary>
public sealed partial class HostPanelViewModel(ShellViewModel shell, HostsViewModel home, string name) : ObservableObject
{
    private const string WorkerOwn = "The worker's own";
    private const int FewRuns = 5;

    private string? _drawn;
    private List<HostRunRow> _allRuns = [];
    private bool _drawing;

    public string Name { get; } = name;

    public ObservableCollection<HostProjectRow> Projects { get; } = [];

    public ObservableCollection<HostSlotRow> Running { get; } = [];

    /// <summary>The newest few, or all the API gave once asked for.</summary>
    public ObservableCollection<HostRunRow> Runs { get; } = [];

    public ObservableCollection<HostDiskRow> Disks { get; } = [];

    public ObservableCollection<string> Serveable { get; } = [];

    public ObservableCollection<string> EngineTokens { get; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanProbe))]
    [NotifyPropertyChangedFor(nameof(IsEnabled))]
    [NotifyPropertyChangedFor(nameof(Drainable))]
    [NotifyPropertyChangedFor(nameof(Switchable))]
    [NotifyPropertyChangedFor(nameof(Taking))]
    [NotifyPropertyChangedFor(nameof(Holding))]
    private Host? _host;

    [ObservableProperty]
    private string? _state;

    [ObservableProperty]
    private string? _connectionState;

    [ObservableProperty]
    private bool _connected;

    [ObservableProperty]
    private bool _notConnected;

    [ObservableProperty]
    private string? _probe;

    [ObservableProperty]
    private string? _probeDetail;

    [ObservableProperty]
    private string? _failedProbe;

    [ObservableProperty]
    private bool _probeFailed;

    [ObservableProperty]
    private string? _summary;

    [ObservableProperty]
    private string? _slots;

    [ObservableProperty]
    private bool _isWorker;

    [ObservableProperty]
    private bool _noProjects;

    [ObservableProperty]
    private string? _machine;

    [ObservableProperty]
    private string? _machineRead;

    [ObservableProperty]
    private string? _machineNote;

    [ObservableProperty]
    private bool _noRuns;

    [ObservableProperty]
    private bool _moreRuns;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(RunsToggle))]
    private bool _showingAllRuns;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Removal))]
    private bool _confirmingRemoval;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanProbe))]
    [NotifyPropertyChangedFor(nameof(Idle))]
    private bool _busy;

    [ObservableProperty]
    private string? _error;

    [ObservableProperty]
    private string? _engineToken;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanServe))]
    private string? _serveProject;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanServe))]
    private string? _codeRoot;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanServe))]
    private string? _worktreeRoot;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanServe))]
    private string? _runRoot;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanServe))]
    private bool _serving;

    [ObservableProperty]
    private string? _serveError;

    public bool Idle => !Busy;

    public bool IsEnabled => Host?.Enabled == true;

    public bool CanProbe => !Busy && IsEnabled;

    public string Drainable => Host?.Draining == true ? "Undrain" : "Drain";

    public string Switchable => IsEnabled ? "Disable" : "Enable";

    public bool Taking => IsEnabled && Host?.Draining == false;

    public bool Holding => IsEnabled && Host?.Draining == true;

    public string Removal => ConfirmingRemoval ? "Confirm remove" : "Remove";

    public string RunsToggle => ShowingAllRuns ? "Show fewer" : $"Show all {_allRuns.Count}";

    public bool CanOffer => Serveable.Count > 0;

    public bool CanServe => !Serving
        && !string.IsNullOrEmpty(ServeProject)
        && !string.IsNullOrEmpty(CodeRoot)
        && !string.IsNullOrEmpty(WorktreeRoot)
        && !string.IsNullOrEmpty(RunRoot);

    [RelayCommand]
    public Task ProbeHostAsync() => DoAsync(sdk => sdk.Hosts.ProbeHostAsync(Name));

    [RelayCommand]
    public Task ToggleDrainAsync() => DoAsync(sdk => sdk.Hosts.UpdateHostAsync(Name, new UpdateHostRequest { Draining = Host?.Draining != true }));

    [RelayCommand]
    public Task ToggleEnabledAsync() => DoAsync(sdk => sdk.Hosts.UpdateHostAsync(Name, new UpdateHostRequest { Enabled = !IsEnabled }));

    [RelayCommand]
    public async Task RemoveAsync()
    {
        if (!ConfirmingRemoval)
        {
            ConfirmingRemoval = true;
            return;
        }

        ConfirmingRemoval = false;
        await DoAsync(sdk => sdk.Hosts.RemoveHostAsync(Name));
    }

    /// <summary>Leaving the button takes back the question, so a later press cannot be the confirming one.</summary>
    public void ForgetRemoval() => ConfirmingRemoval = false;

    [RelayCommand]
    public Task StopServingAsync(HostProjectRow row)
    {
        ArgumentNullException.ThrowIfNull(row);

        return DoAsync(sdk => sdk.Hosts.RemoveHostProjectAsync(Name, row.Project));
    }

    [RelayCommand]
    public void OpenCard(HostSlotRow row)
    {
        ArgumentNullException.ThrowIfNull(row);

        home.OpenCard(row.Project, row.CardId);
    }

    [RelayCommand]
    public void OpenRun(HostRunRow row)
    {
        ArgumentNullException.ThrowIfNull(row);

        home.OpenCard(row.Project, row.CardId);
    }

    [RelayCommand]
    public void ToggleRuns()
    {
        ShowingAllRuns = !ShowingAllRuns;
        DrawRuns();
    }

    [RelayCommand]
    public async Task ServeAsync()
    {
        Serving = true;
        ServeError = null;
        try
        {
            await shell.Connection!.Sdk.Hosts.SetHostProjectAsync(
                Name,
                ServeProject!,
                new PutHostProjectRequest { CodeRoot = CodeRoot!, WorktreeRoot = WorktreeRoot!, RunRoot = RunRoot! });
            ServeProject = null;
            CodeRoot = null;
            WorktreeRoot = null;
            RunRoot = null;
            await home.ReadAsync(CancellationToken.None);
        }
        catch (HttpRequestException failure)
        {
            ServeError = ApiError.Reason(failure);
        }
        finally
        {
            Serving = false;
        }
    }

    /// <summary>What the server says now. Lists are only redrawn when they changed, as a redraw would close a menu left open.</summary>
    public void Draw(Host host, IReadOnlyList<HostRun> runs, IReadOnlyList<string> projects, IReadOnlyList<string> tokens, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(host);
        ArgumentNullException.ThrowIfNull(runs);
        ArgumentNullException.ThrowIfNull(projects);
        ArgumentNullException.ThrowIfNull(tokens);

        _drawing = true;
        Host = host;
        State = HostRules.State(host);
        ConnectionState = HostRules.Connection(host, now);
        Connected = host.Connection is not null;
        NotConnected = host.Kind == HostKind.Worker && host.Connection is null;
        Probe = HostRules.Probe(host, now);
        ProbeDetail = host.Probe is null ? null : host.Probe.Detail ?? "every check passed";
        ProbeFailed = host.Probe is { Ok: false, Detail: not null };
        FailedProbe = ProbeFailed ? host.Probe!.Detail : null;
        Summary = HostRules.Summary(host, now);
        Slots = HostRules.Slots(host);
        IsWorker = host.Kind == HostKind.Worker;
        NoProjects = host.Projects.Count == 0;

        var running = host.Running.Select(use => new HostSlotRow($"slot {use.Slot}:", use.Project, use.CardId, $"{use.Project} {use.CardId}", $"since {HostRules.Relative(use.Since, now)}", this)).ToList();
        Replace(Running, running);

        var metrics = host.Connection?.Metrics;
        Machine = metrics is null ? null : HostRules.Machine(metrics);
        MachineRead = metrics is null ? "Machine" : $"Machine, read {HostRules.Relative(metrics.SampledAt, now)}";
        MachineNote = HostRules.MachineNote(host);
        Replace(Disks, metrics?.Disks.Select(disk => new HostDiskRow(HostRules.Disk(disk), HostRules.DiskLow(disk))).ToList() ?? []);

        _allRuns = runs.Select(run => new HostRunRow(
            HostRules.Outcome(run),
            run.Outcome is HostRunOutcome.Passed or HostRunOutcome.Running,
            run.Outcome is HostRunOutcome.Interrupted or HostRunOutcome.Abandoned,
            run.Outcome is HostRunOutcome.Failed or HostRunOutcome.Lost,
            run.Project,
            run.CardId,
            $"{run.Project} {run.CardId}",
            HostRules.RunDetail(run, now),
            this)).ToList();
        DrawRuns();

        var fingerprint = System.Text.Json.JsonSerializer.Serialize(new { host.Projects, projects, tokens });
        if (fingerprint != _drawn)
        {
            _drawn = fingerprint;
            Replace(Projects, host.Projects.Select(project => new HostProjectRow(project.Project, project.CodeRoot, $"worktrees {project.WorktreeRoot} · run {project.RunRoot}", this)).ToList());
            Replace(Serveable, projects.Where(project => host.Projects.All(served => served.Project != project)).ToList());
            Replace(EngineTokens, [WorkerOwn, .. tokens]);
            OnPropertyChanged(nameof(CanOffer));
        }

        EngineToken = host.EngineToken ?? WorkerOwn;
        _drawing = false;
    }

    partial void OnEngineTokenChanged(string? value)
    {
        if (_drawing || value is null || value == (Host?.EngineToken ?? WorkerOwn))
        {
            return;
        }

        _ = DoAsync(sdk => value == WorkerOwn
            ? sdk.Hosts.UnassignEngineTokenAsync(Name)
            : sdk.Hosts.AssignEngineTokenAsync(Name, new PutHostEngineTokenRequest { Name = value }));
    }

    private void DrawRuns()
    {
        NoRuns = _allRuns.Count == 0;
        MoreRuns = _allRuns.Count > FewRuns;
        OnPropertyChanged(nameof(RunsToggle));
        Replace(Runs, ShowingAllRuns ? _allRuns : _allRuns.Take(FewRuns).ToList());
    }

    private static void Replace<T>(ObservableCollection<T> shown, IReadOnlyList<T> items)
    {
        if (shown.SequenceEqual(items))
        {
            return;
        }

        shown.Clear();
        foreach (var item in items)
        {
            shown.Add(item);
        }
    }

    private async Task DoAsync(Func<Sdk.WilsonSdk, Task> action)
    {
        Busy = true;
        Error = null;
        try
        {
            await action(shell.Connection!.Sdk);
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        await home.ReadAsync(CancellationToken.None);
        Busy = false;
    }
}
