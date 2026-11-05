using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Apps;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>One installed app, as listed. It carries the page because the row's own context is the app.</summary>
public sealed class AppRow(AppSummary app, AppsViewModel page)
{
    public AppsViewModel Page => page;

    public string Slug => app.Slug;

    public string Name => app.Name;

    public string Description => app.Description;

    public bool HasDescription => app.Description.Length > 0;

    /// <summary>Said on the list, as this is all that says what an app can reach.</summary>
    public string Reads => app.Grants.Count == 0 ? "Reads nothing" : $"Reads: {string.Join(", ", app.Grants.Select(AppDocument.GrantLabel))}";
}

/// <summary>The installed apps, which is `routes/projects.$project.apps.index.tsx`. Apps belong to the server and open in this project.</summary>
public sealed partial class AppsViewModel(ShellViewModel shell, string project) : PageViewModel
{
    public ObservableCollection<AppRow> Apps { get; } = [];

    public ShellViewModel Shell => shell;

    public string Project => project;

    [ObservableProperty]
    private bool _empty;

    [ObservableProperty]
    private string? _error;

    [RelayCommand]
    public void Open(string slug) => shell.Push(new AppViewModel(shell, project, slug));

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        try
        {
            var apps = await shell.Connection!.Sdk.Apps.ListAppsAsync(cancellationToken);
            Apps.Clear();
            foreach (var app in apps)
            {
                Apps.Add(new AppRow(app, this));
            }

            Empty = apps.Count == 0;
            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load the apps: {ApiError.Reason(failure)}";
        }
    }
}
