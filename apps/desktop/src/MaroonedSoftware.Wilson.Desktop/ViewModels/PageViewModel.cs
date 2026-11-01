using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

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
    }

    public void Dispose()
    {
        Hidden();
        GC.SuppressFinalize(this);
    }

    /// <summary>Reads what the page shows and follows it, for as long as the token stands.</summary>
    protected abstract Task OnShownAsync(CancellationToken cancellationToken);

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
