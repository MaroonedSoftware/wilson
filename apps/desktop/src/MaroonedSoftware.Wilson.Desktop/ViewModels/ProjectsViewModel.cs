using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>Every project on this server. Names only, as that is all the API answers without a request per project.</summary>
public sealed partial class ProjectsViewModel(ShellViewModel shell) : PageViewModel
{
    public ObservableCollection<string> Projects { get; } = [];

    [ObservableProperty]
    private string? _error;

    [RelayCommand]
    public void NewProject() => shell.Push(new NewProjectViewModel(shell));

    [RelayCommand]
    public void Open(string project) => shell.ShowProject(project);

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        try
        {
            var projects = await shell.Connection!.Sdk.Projects.ListProjectsAsync(cancellationToken);
            Projects.Clear();
            foreach (var project in projects)
            {
                Projects.Add(project.Name);
            }

            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Could not load projects: {ApiError.Reason(failure)}";
        }
    }
}
