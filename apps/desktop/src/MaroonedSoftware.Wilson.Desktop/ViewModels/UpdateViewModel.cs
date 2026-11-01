using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Updates;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>The strip that says a new version exists. It never changes anything without being asked.</summary>
public sealed partial class UpdateViewModel(UpdateChecker checker) : ObservableObject
{
    private static readonly TimeSpan Again = TimeSpan.FromHours(6);

    private string? _page;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Visible))]
    private string? _message;

    public bool Visible => Message is not null;

    /// <summary>Checks at launch and every six hours after, because this app is left open for days.</summary>
    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        using var timer = new PeriodicTimer(Again);
        do
        {
            if (await checker.CheckAsync(cancellationToken) is { } found)
            {
                _page = found.Page;
                Message = $"Wilson {found.Version} is available.";
            }
        }
        while (await timer.WaitForNextTickAsync(cancellationToken));
    }

    [RelayCommand]
    public void ViewRelease()
    {
        if (_page is { } page && page.StartsWith("https://", StringComparison.Ordinal))
        {
            using var opened = Process.Start(new ProcessStartInfo("open") { ArgumentList = { page } });
        }
    }
}
