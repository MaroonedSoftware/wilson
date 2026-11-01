using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>A chat in the list, as drawn.</summary>
public sealed record ThreadRow(string Id, string Title, bool Current);

/// <summary>The window's home: the chats still open, and one of them. A thread belongs to the operator, not to a project.</summary>
public sealed partial class ThreadsViewModel(ShellViewModel shell) : PageViewModel
{
    private string? _openId;

    public ObservableCollection<ThreadRow> Threads { get; } = [];

    public ShellViewModel Shell => shell;

    [ObservableProperty]
    private ChatViewModel? _chat;

    [ObservableProperty]
    private string? _error;

    /// <summary>Only once the list has said so: until then there may well be a chat to open.</summary>
    [ObservableProperty]
    private bool _noChats;

    [RelayCommand]
    public async Task StartThreadAsync()
    {
        try
        {
            var thread = await shell.Connection!.Sdk.Chat.StartAChatThreadAsync();
            Show(thread.Id);
            await ListAsync(CancellationToken.None);
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
    }

    [RelayCommand]
    public void Open(ThreadRow thread)
    {
        ArgumentNullException.ThrowIfNull(thread);

        if (thread.Id != _openId)
        {
            Show(thread.Id);
            for (var index = 0; index < Threads.Count; index++)
            {
                Threads[index] = Threads[index] with { Current = Threads[index].Id == _openId };
            }
        }
    }

    [RelayCommand]
    public void OpenBoard() => shell.Push(new BoardViewModel(shell));

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        Chat?.Shown();
        await ListAsync(cancellationToken);
        if (Chat is null && Threads.FirstOrDefault() is { } latest)
        {
            Open(latest);
        }

        NoChats = Chat is null && Error is null;
    }

    protected override void OnHidden() => Chat?.Hidden();

    private void Show(string id)
    {
        Chat?.Dispose();
        _openId = id;
        NoChats = false;
        Chat = new ChatViewModel(shell, id, () => ListAsync(CancellationToken.None));
        Chat.Shown();
    }

    /// <summary>Read again after a turn too, because a chat's first message is what names it.</summary>
    private async Task ListAsync(CancellationToken cancellationToken)
    {
        try
        {
            var threads = await shell.Connection!.Sdk.Chat.ListChatThreadsAsync(cancellationToken);
            Threads.Clear();
            foreach (var thread in threads.Where(thread => thread.ArchivedAt is null))
            {
                Threads.Add(new ThreadRow(thread.Id, thread.Title, thread.Id == _openId));
            }
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
    }
}
