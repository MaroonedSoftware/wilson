using System.Collections.Specialized;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Settings;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>`ChatDock.tsx`: the home page's own conversation beside another page, with its chats in a picker.</summary>
public sealed partial class ChatDockViewModel : ObservableObject, IDisposable
{
    private readonly ShellViewModel _shell;

    public ChatDockViewModel(ShellViewModel shell, ThreadsViewModel home)
    {
        _shell = shell;
        Home = home;
        Home.Threads.CollectionChanged += OnThreadsChanged;
    }

    public ThreadsViewModel Home { get; }

    public bool OnTheRight => _shell.Dock.Position == ChatDockPosition.Right;

    public bool AtTheBottom => !OnTheRight;

    /// <summary>The chat open, chosen here or on the page. A read of the list empties it for a moment, which picks nothing.</summary>
    public ThreadRow? Picked
    {
        get => Home.Threads.FirstOrDefault(thread => thread.Current);
        set
        {
            if (value is { Current: false })
            {
                Home.Open(value);
            }
        }
    }

    [RelayCommand]
    public void Move()
    {
        _shell.MoveDock(OnTheRight ? ChatDockPosition.Bottom : ChatDockPosition.Right);
        OnPropertyChanged(nameof(OnTheRight));
        OnPropertyChanged(nameof(AtTheBottom));
    }

    [RelayCommand]
    public void OpenAsHome() => _shell.ShowChat();

    [RelayCommand]
    public void Close() => _shell.ToggleDock();

    public void Dispose() => Home.Threads.CollectionChanged -= OnThreadsChanged;

    private void OnThreadsChanged(object? sender, NotifyCollectionChangedEventArgs e) => OnPropertyChanged(nameof(Picked));
}
