using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>A page following the feed, whose state the window's header shows.</summary>
public interface IFollowsFeed
{
    bool Live { get; }

    /// <summary>The project this page is about, for the header's link to its activity.</summary>
    string? Project { get; }

    IAsyncRelayCommand RefreshCommand { get; }
}

/// <summary>A screen. It works only while shown: leaving it cancels whatever it was following.</summary>
public abstract class PageViewModel : ObservableObject, IDisposable
{
    private CancellationTokenSource? _shown;

    /// <summary>Called each time the page comes to the front, including coming back to it.</summary>
    public void Shown()
    {
        Hidden();
        _shown = new CancellationTokenSource();
        _ = RunAsync(_shown.Token);
    }

    public void Hidden()
    {
        _shown?.Cancel();
        _shown?.Dispose();
        _shown = null;
        OnHidden();
    }

    public void Dispose()
    {
        Hidden();
        GC.SuppressFinalize(this);
    }

    /// <summary>Reads what the page shows and follows it, for as long as the token stands.</summary>
    protected abstract Task OnShownAsync(CancellationToken cancellationToken);

    /// <summary>Calls `tick` on the page's own context until the page is left, for what a clock alone changes.</summary>
    protected static async Task EveryAsync(TimeSpan period, Action tick, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(tick);

        using var timer = new PeriodicTimer(period);
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                tick();
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Leaving the page is how the clock stops.
        }
    }

    /// <summary>For a page that holds another: what it shows has to stop with it.</summary>
    protected virtual void OnHidden()
    {
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        try
        {
            await OnShownAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Leaving the page is how its work ends.
        }
        catch (HttpRequestException failure)
        {
            Trace.WriteLine($"page: {failure.Message}");
        }
    }
}
