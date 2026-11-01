using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>A chat in the rail, as drawn. It carries the page because its menu opens in a popup, away from the view's tree.</summary>
public sealed record ThreadRow(string Id, string Title, string When, bool Current, ThreadsViewModel Home);

/// <summary>The window's home: the chats still open, and one of them. A thread belongs to the operator, not to a project.</summary>
public sealed partial class ThreadsViewModel(ShellViewModel shell) : PageViewModel
{
    private const int LongestTitle = 120;

    public ObservableCollection<ThreadRow> Threads { get; } = [];

    public ShellViewModel Shell => shell;

    [ObservableProperty]
    private ChatViewModel? _chat;

    [ObservableProperty]
    private string? _error;

    /// <summary>Only once the list has said so: until then there may well be chats to show.</summary>
    [ObservableProperty]
    private bool _noChats;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsRenaming))]
    private ThreadRow? _renaming;

    [ObservableProperty]
    private string? _newTitle;

    public bool IsRenaming => Renaming is not null;

    [RelayCommand]
    public void NewChat() => Show(null);

    [RelayCommand]
    public void Open(ThreadRow thread)
    {
        ArgumentNullException.ThrowIfNull(thread);

        if (thread.Id != Chat?.Id)
        {
            Show(thread.Id);
        }
    }

    [RelayCommand]
    public void OpenBoard() => shell.Push(new BoardViewModel(shell));

    [RelayCommand]
    public void AskRename(ThreadRow thread)
    {
        ArgumentNullException.ThrowIfNull(thread);

        NewTitle = thread.Title;
        Renaming = thread;
    }

    [RelayCommand]
    public void CancelRename() => Renaming = null;

    [RelayCommand]
    public async Task SaveRenameAsync()
    {
        var title = NewTitle?.Trim() ?? string.Empty;
        if (Renaming is not { } thread || title.Length == 0)
        {
            return;
        }

        Renaming = null;
        try
        {
            await shell.Connection!.Sdk.Chat.RenameAChatThreadAsync(thread.Id, new RenameChatThreadRequest { Title = title[..Math.Min(title.Length, LongestTitle)] });
            await ListAsync(CancellationToken.None);
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
    }

    [RelayCommand]
    public async Task ArchiveAsync(ThreadRow thread)
    {
        ArgumentNullException.ThrowIfNull(thread);

        try
        {
            await shell.Connection!.Sdk.Chat.ArchiveAChatThreadAsync(thread.Id);
            if (thread.Id == Chat?.Id)
            {
                Show(null);
            }

            await ListAsync(CancellationToken.None);
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
    }

    /// <summary>A new chat has its thread: it stays open, and joins the rail.</summary>
    public void Started(string id)
    {
        shell.RememberThread(id);
        _ = ListAsync(CancellationToken.None);
    }

    /// <summary>Read again after a turn, because a chat's first message is what names it.</summary>
    public Task AnsweredAsync() => ListAsync(CancellationToken.None);

    /// <summary>The open chat no longer exists, so the page opens on a new one rather than an error.</summary>
    public void Gone()
    {
        Show(null);
        _ = ListAsync(CancellationToken.None);
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        if (Chat is null)
        {
            Show(shell.Settings.Thread);
        }
        else
        {
            Chat.Shown();
        }

        await ListAsync(cancellationToken);
    }

    protected override void OnHidden() => Chat?.Hidden();

    private void Show(string? id)
    {
        Chat?.Dispose();
        shell.RememberThread(id);
        Chat = new ChatViewModel(shell, this, id);
        Chat.Shown();
        for (var index = 0; index < Threads.Count; index++)
        {
            Threads[index] = Threads[index] with { Current = Threads[index].Id == id };
        }
    }

    private async Task ListAsync(CancellationToken cancellationToken)
    {
        try
        {
            var threads = await shell.Connection!.Sdk.Chat.ListChatThreadsAsync(cancellationToken);
            var now = DateTimeOffset.UtcNow;
            Threads.Clear();
            foreach (var thread in threads.Where(thread => thread.ArchivedAt is null))
            {
                Threads.Add(new ThreadRow(thread.Id, thread.Title, ChatRules.Relative(thread.UpdatedAt, now), thread.Id == Chat?.Id, this));
            }

            NoChats = Threads.Count == 0;
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
    }
}
