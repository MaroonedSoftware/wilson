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
    private static readonly TimeSpan Linger = TimeSpan.FromSeconds(5);

    private string? _zip;
    private Version? _version;
    private bool _checking;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanView))]
    private string? _page;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Visible))]
    private string? _message;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanView))]
    private bool _ready;

    [ObservableProperty]
    private bool _installing;

    public bool Visible => Message is not null;

    public bool CanView => !Ready && Page is not null;

    /// <summary>Checks at launch and every six hours after, because this app is left open for days.</summary>
    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        using var timer = new PeriodicTimer(Again);
        do
        {
            await CheckAsync(asked: false, cancellationToken);
        }
        while (await timer.WaitForNextTickAsync(cancellationToken));
    }

    /// <summary>The menu's check. It differs from the timer's by saying so when there is nothing to offer.</summary>
    public Task CheckNowAsync() => CheckAsync(asked: true, CancellationToken.None);

    [RelayCommand]
    public void ViewRelease()
    {
        if (Page is { } page && page.StartsWith("https://", StringComparison.Ordinal))
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

    private async Task CheckAsync(bool asked, CancellationToken cancellationToken)
    {
        // A second check would download the same update twice.
        if (_checking)
        {
            return;
        }

        _checking = true;
        try
        {
            var result = await checker.CheckAsync(cancellationToken);
            if (result.Found is { } found)
            {
                if (found.Version != _version)
                {
                    await OfferAsync(found, cancellationToken);
                }
            }
            else if (asked)
            {
                await SayAsync(result.Answered ? $"Wilson {UpdateCheck.Current} is up to date." : "Could not check for updates.");
            }
        }
        finally
        {
            _checking = false;
        }
    }

    /// <summary>A brief answer in the strip, which then goes back to whatever it was saying.</summary>
    private async Task SayAsync(string message)
    {
        var before = Message;
        Message = message;
        await Task.Delay(Linger);
        Message = before;
    }

    private async Task OfferAsync(UpdateAvailable found, CancellationToken cancellationToken)
    {
        Page = found.Page;
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
