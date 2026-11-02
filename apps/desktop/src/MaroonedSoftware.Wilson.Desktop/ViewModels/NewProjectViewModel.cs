using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>Which path field a folder is being browsed for.</summary>
public enum PathField
{
    CodeRoot,
    WorktreeRoot,
    RunRoot,
}

/// <summary>
/// `wilson project create` and `wilson board init` in one form, by `NewProjectControl.tsx`. They are two
/// writes and no transaction. If the first lands and the second fails, the name is remembered and a
/// retry only initialises, as registering it again would be refused as taken. The worktree and run
/// roots follow the code root until someone types or picks one.
/// </summary>
public sealed partial class NewProjectViewModel(ShellViewModel shell) : PageViewModel
{
    private string? _registered;
    private PathField _browsing;

    public ObservableCollection<string> Repositories { get; } = [];

    public ObservableCollection<string> Folders { get; } = [];

    public ShellViewModel Shell => shell;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShownWorktreeRoot))]
    [NotifyPropertyChangedFor(nameof(ShownRunRoot))]
    [NotifyPropertyChangedFor(nameof(CanCreate))]
    private string? _name;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(UsesPaths))]
    [NotifyPropertyChangedFor(nameof(CanCreate))]
    private string? _repository;

    [ObservableProperty]
    private bool _hasRepositories;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShownWorktreeRoot))]
    [NotifyPropertyChangedFor(nameof(ShownRunRoot))]
    [NotifyPropertyChangedFor(nameof(CanCreate))]
    private string? _codeRoot;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShownWorktreeRoot))]
    [NotifyPropertyChangedFor(nameof(CanCreate))]
    private string? _worktreeRoot;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShownRunRoot))]
    [NotifyPropertyChangedFor(nameof(CanCreate))]
    private string? _runRoot;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanCreate))]
    private bool _busy;

    [ObservableProperty]
    private string? _failureTitle;

    [ObservableProperty]
    private string? _failure;

    [ObservableProperty]
    private bool _picking;

    [ObservableProperty]
    private string? _pickTitle;

    [ObservableProperty]
    private DirectoryListing? _listing;

    [ObservableProperty]
    private string? _pickError;

    [ObservableProperty]
    private bool _canGoToTop;

    [ObservableProperty]
    private bool _showHidden;

    public bool UsesPaths => Repository is null;

    public string ShownWorktreeRoot
    {
        get => WorktreeRoot ?? ProjectPaths.Defaults(Name, CodeRoot).WorktreeRoot;
        set => WorktreeRoot = value;
    }

    public string ShownRunRoot
    {
        get => RunRoot ?? ProjectPaths.Defaults(Name, CodeRoot).RunRoot;
        set => RunRoot = value;
    }

    public bool CanCreate =>
        !Busy
        && !string.IsNullOrWhiteSpace(Name)
        && (Repository is not null
            || (!string.IsNullOrWhiteSpace(CodeRoot) && !string.IsNullOrWhiteSpace(ShownWorktreeRoot) && !string.IsNullOrWhiteSpace(ShownRunRoot)));

    [RelayCommand]
    public void ClearRepository() => Repository = null;

    [RelayCommand]
    public async Task CreateAsync()
    {
        if (!CanCreate)
        {
            return;
        }

        var name = Name!.Trim();
        Busy = true;
        Failure = null;
        try
        {
            if (_registered != name)
            {
                await shell.Connection!.Sdk.Projects.RegisterProjectAsync(Request(name));
                _registered = name;
            }
        }
        catch (HttpRequestException failure)
        {
            FailureTitle = "Could not register the project";
            Failure = ApiError.Reason(failure);
            Busy = false;
            return;
        }

        try
        {
            using var sdk = shell.Connection!.ForProject(name);
            await sdk.Board.InitialiseBoardAsync();
            await shell.ProjectAddedAsync(name);
        }
        catch (HttpRequestException failure)
        {
            FailureTitle = "Registered, but could not initialise its board";
            Failure = $"{ApiError.Reason(failure)} Creating it again only retries initialising the board.";
        }
        finally
        {
            Busy = false;
        }
    }

    /// <summary>Browsing starts at the field's own value when that is absolute, and otherwise at the top folder the server allows.</summary>
    [RelayCommand]
    public Task BrowseAsync(PathField field)
    {
        _browsing = field;
        (PickTitle, var value) = field switch
        {
            PathField.CodeRoot => ("Choose code root", CodeRoot),
            PathField.WorktreeRoot => ("Choose worktree root", ShownWorktreeRoot),
            _ => ("Choose run root", ShownRunRoot),
        };
        Picking = true;
        var start = value?.Trim() ?? string.Empty;
        return ListAsync(start.StartsWith('/') ? start : null);
    }

    [RelayCommand]
    public Task OpenFolderAsync(string name) => Listing is { } listing ? ListAsync(ProjectPaths.Child(listing.Path, name)) : Task.CompletedTask;

    [RelayCommand]
    public Task UpAsync() => Listing?.Parent is { } parent ? ListAsync(parent) : Task.CompletedTask;

    [RelayCommand]
    public Task GoToTopAsync() => ListAsync(null);

    [RelayCommand]
    public void CancelPick() => Picking = false;

    [RelayCommand]
    public void SelectFolder()
    {
        if (Listing is not { } listing)
        {
            return;
        }

        switch (_browsing)
        {
            case PathField.CodeRoot:
                CodeRoot = listing.Path;
                if (string.IsNullOrWhiteSpace(Name))
                {
                    Name = ProjectPaths.LastSegment(listing.Path);
                }

                break;
            case PathField.WorktreeRoot:
                ShownWorktreeRoot = listing.Path;
                break;
            default:
                ShownRunRoot = listing.Path;
                break;
        }

        Picking = false;
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        try
        {
            var listing = await shell.Connection!.Sdk.Projects.ListRepositoriesAsync(cancellationToken);
            Repositories.Clear();
            foreach (var repository in listing.Repositories)
            {
                Repositories.Add(repository.FullName);
            }

            HasRepositories = listing.Configured;
        }
        catch (HttpRequestException)
        {
            // No app, or a listing that fails, simply leaves the paths.
            HasRepositories = false;
        }
    }

    partial void OnRepositoryChanged(string? value)
    {
        if (value is not null && string.IsNullOrWhiteSpace(Name))
        {
            Name = ProjectPaths.LastSegment(value);
        }
    }

    partial void OnShowHiddenChanged(bool value) => DrawFolders();

    private CreateProjectRequest Request(string name) => Repository is { } repository
        ? new CreateProjectRequest { Name = name, Repository = repository }
        : new CreateProjectRequest { Name = name, CodeRoot = CodeRoot!.Trim(), WorktreeRoot = ShownWorktreeRoot.Trim(), RunRoot = ShownRunRoot.Trim() };

    /// <summary>
    /// A proposed root usually does not exist yet, so a missing folder opens its nearest existing
    /// parent. Any other refusal offers the top folder rather than leaving the dialog stuck.
    /// </summary>
    private async Task ListAsync(string? path)
    {
        var candidate = path;
        while (true)
        {
            try
            {
                Listing = await shell.Connection!.Sdk.Projects.ListDirectoriesAsync(candidate is null ? new DirectoryQuery() : new DirectoryQuery { Path = candidate });
                PickError = null;
                CanGoToTop = false;
                DrawFolders();
                return;
            }
            catch (SdkException failure) when (failure.Status == 404 && candidate is not (null or "/"))
            {
                candidate = ProjectPaths.Parent(candidate);
            }
            catch (HttpRequestException failure)
            {
                Listing = null;
                Folders.Clear();
                PickError = ApiError.Reason(failure);
                CanGoToTop = candidate is not null;
                return;
            }
        }
    }

    private void DrawFolders()
    {
        Folders.Clear();
        foreach (var name in Listing?.Directories ?? [])
        {
            if (ShowHidden || !name.StartsWith('.'))
            {
                Folders.Add(name);
            }
        }
    }
}
