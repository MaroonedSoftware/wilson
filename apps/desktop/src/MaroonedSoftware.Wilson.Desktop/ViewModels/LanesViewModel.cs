using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Runner;
using MaroonedSoftware.Wilson.Sdk;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>One lane's instructions and settings, a draft saved on its own. It shows what the server kept, and a refusal keeps the attempt.</summary>
public sealed partial class LaneRow(Lane lane, WilsonSdk sdk) : ObservableObject
{
    public string Name { get; } = lane.Name;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Summary))]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private Lane _stored = lane;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private string? _instructions = lane.Instructions;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    [NotifyPropertyChangedFor(nameof(SettingsProblem))]
    private string? _settings = LaneRules.SettingsText(lane.Settings);

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private bool _idle = true;

    [ObservableProperty]
    private string? _error;

    public string Summary => LaneRules.Summary(Stored);

    public string? SettingsProblem => LaneRules.ReadSettings(Stored.Settings, Settings).Problem;

    public bool CanSave => Idle && SettingsProblem is null && Request() is not null;

    [RelayCommand]
    public async Task SaveAsync()
    {
        if (!CanSave)
        {
            return;
        }

        Idle = false;
        Error = null;
        try
        {
            var saved = await sdk.Stages.UpdateLaneAsync(Name, Request()!);
            Stored = saved;
            Instructions = saved.Instructions;
            Settings = LaneRules.SettingsText(saved.Settings);
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        Idle = true;
    }

    private PatchLaneRequest? Request() => LaneRules.Patch(Stored, Instructions, LaneRules.ReadSettings(Stored.Settings, Settings).Patch);
}

/// <summary>One project's lanes. They belong to a project, so this opens from one, as Activity does.</summary>
public sealed partial class LanesViewModel : PageViewModel
{
    private readonly WilsonSdk _sdk;

    public LanesViewModel(ShellViewModel shell, string project)
    {
        _sdk = shell.Connection!.ForProject(project);
        Shell = shell;
        Project = project;
        Routing = new StageRoutingControl(() => _sdk);
    }

    public ShellViewModel Shell { get; }

    public string Project { get; }

    public StageRoutingControl Routing { get; }

    [ObservableProperty]
    private IReadOnlyList<LaneRow> _rows = [];

    [ObservableProperty]
    private string? _error;

    protected override Task OnShownAsync(CancellationToken cancellationToken) =>
        Task.WhenAll(ReadLanesAsync(cancellationToken), Routing.ReadAsync(cancellationToken));

    private async Task ReadLanesAsync(CancellationToken cancellationToken)
    {
        try
        {
            var lanes = await _sdk.Stages.ListLanesAsync(cancellationToken);
            Rows = [.. lanes.OrderBy(lane => lane.Position).Select(lane => new LaneRow(lane, _sdk))];
            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load the lanes: {ApiError.Reason(failure)}";
        }
    }
}
