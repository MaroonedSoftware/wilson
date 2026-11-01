using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Updates;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>
/// The strip that says a new version exists. A verified update waits in the background and the app
/// restarts only when asked, so a planning turn or a merge is never cut off.
/// </summary>
public sealed partial class UpdateViewModel(UpdateChecker checker, UpdateDownloader? downloader, IUpdateInstaller? installer, string? bundle, Action quit) : ObservableObject
{
    private static readonly TimeSpan Again = TimeSpan.FromHours(6);

    private string? _page;
    private string? _zip;
    private Version? _version;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Visible))]
    private string? _message;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanView))]
    private bool _ready;

    [ObservableProperty]
    private bool _installing;

    public bool Visible => Message is not null;

    public bool CanView => !Ready;

    /// <summary>Checks at launch and every six hours after, because this app is left open for days.</summary>
    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        using var timer = new PeriodicTimer(Again);
        do
        {
            if (await checker.CheckAsync(cancellationToken) is { } found && found.Version != _version)
            {
                await OfferAsync(found, cancellationToken);
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

    [RelayCommand]
    public async Task RestartAsync()
    {
        if (installer is null || bundle is null || _zip is null)
        {
            return;
        }

        Installing = true;
        if (await installer.PrepareAsync(_zip, bundle) is { } staging)
        {
            installer.SwapAfterExit(staging, bundle);
            quit();
            return;
        }

        Installing = false;
        Ready = false;
        Message = $"Wilson {_version} could not be installed here, so it will need installing by hand.";
    }

    private async Task OfferAsync(UpdateAvailable found, CancellationToken cancellationToken)
    {
        _page = found.Page;
        Ready = false;
        Message = $"Wilson {found.Version} is available.";

        if (downloader is not null && installer is not null && bundle is not null
            && await downloader.DownloadAsync(found, cancellationToken) is { } zip)
        {
            _zip = zip;
            _version = found.Version;
            Message = $"Wilson {found.Version} is ready.";
            Ready = true;
        }
    }
}
