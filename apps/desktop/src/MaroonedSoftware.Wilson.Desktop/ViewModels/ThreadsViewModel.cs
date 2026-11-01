using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>The chats still open. A thread belongs to the operator, not to a project.</summary>
public sealed partial class ThreadsViewModel(ShellViewModel shell) : PageViewModel
{
    public ObservableCollection<ChatThread> Threads { get; } = [];

    public ShellViewModel Shell => shell;

    [ObservableProperty]
    private string? _error;

    [RelayCommand]
    public async Task StartThreadAsync()
    {
        try
        {
            Open(await shell.Connection!.Sdk.Chat.StartAChatThreadAsync());
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
    }

    [RelayCommand]
    public void Open(ChatThread thread)
    {
        ArgumentNullException.ThrowIfNull(thread);

        shell.Push(new ChatViewModel(shell, thread.Id));
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        try
        {
            var threads = await shell.Connection!.Sdk.Chat.ListChatThreadsAsync(cancellationToken);
            Threads.Clear();
            foreach (var thread in threads.Where(thread => thread.ArchivedAt is null))
            {
                Threads.Add(thread);
            }
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
    }
}
