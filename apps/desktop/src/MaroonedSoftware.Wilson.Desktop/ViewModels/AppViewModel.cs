using Avalonia;
using Avalonia.Styling;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Apps;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Desktop.Mac;
using InstalledApp = MaroonedSoftware.Wilson.Sdk.Models.App;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>
/// One operator app open in one project, which is `routes/projects.$project.apps.$slug.tsx` and `AppFrame.tsx`.
/// Its project is fixed for as long as this page lives, as the client behind the broker carries it, and
/// there is nothing else an app can name. Its document lives only while the page is in front.
/// </summary>
public sealed partial class AppViewModel(ShellViewModel shell, string project, string slug) : PageViewModel
{
    /// <summary>How long the board has to stay quiet before an app is told it changed, the web app's figure.</summary>
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(300);

    private InstalledApp? _app;
    private AppBroker? _broker;
    private MacAppWebView? _view;
    private CancellationTokenSource? _settling;

    public ShellViewModel Shell => shell;

    public string Project => project;

    [ObservableProperty]
    private string _name = string.Empty;

    [ObservableProperty]
    private string? _error;

    /// <summary>It tried to navigate, was stopped, and has been taken away.</summary>
    [ObservableProperty]
    private bool _left;

    /// <summary>Whether a web view should be on screen. The view makes one when this turns on, and drops it when it turns off.</summary>
    [ObservableProperty]
    private bool _running;

    /// <summary>The colour scheme Wilson is showing now, read from the app's theme rather than kept.</summary>
    private static AppColorScheme ColorScheme =>
        Application.Current?.ActualThemeVariant == ThemeVariant.Dark ? AppColorScheme.Dark : AppColorScheme.Light;

    /// <summary>A fresh document and a fresh broker, as after an app has left, the old ones can no longer be trusted.</summary>
    [RelayCommand]
    public void OpenAgain()
    {
        Left = false;
        Running = _app is not null;
    }

    /// <summary>What the view calls when it needs a web view for this app.</summary>
    public MacAppWebView MakeView()
    {
        var app = _app ?? throw new InvalidOperationException("no app has been read yet");
        CloseApp();

        var view = new MacAppWebView(AppDocument.Build(app.Html, project, app.Grants, ColorScheme), ColorScheme);
        var broker = new AppBroker(
            app.Grants,
            shell.Connection!.AppReadsFor(project),
            answer => Dispatcher.UIThread.Post(() => view.Send(answer)),
            card => Dispatcher.UIThread.Post(() => shell.Push(new CardViewModel(shell, project, card))));
        view.Received += message => _ = broker.ReceiveAsync(message);

        // Posted, as these arrive inside WebKit's own call and answering them takes the view away.
        view.Left += () => Dispatcher.UIThread.Post(() =>
        {
            if (_view == view)
            {
                CloseApp();
                Left = true;
                Running = false;
            }
        });
        view.Failed += reason => Dispatcher.UIThread.Post(() =>
        {
            if (_view == view)
            {
                CloseApp();
                Error = reason;
                Running = false;
            }
        });
        _view = view;
        _broker = broker;
        return view;
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        try
        {
            _app = await shell.Connection!.Sdk.Apps.GetAppAsync(slug, cancellationToken);
            Name = _app.Name;
            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load this app: {ApiError.Reason(failure)}";
            return;
        }

        // Not opened at all, as the answers it would get are not the ones it was written for.
        if (AppDocument.UnsupportedApiVersion(_app.ApiVersion) is { } unsupported)
        {
            Error = $"{_app.Name} needs a newer Wilson. {unsupported}";
            _app = null;
            return;
        }

        if (Application.Current is { } application)
        {
            application.ActualThemeVariantChanged += TellColorScheme;
        }

        Running = true;

        // A change goes only to an app with a grant, since even its timing says something about the board.
        if (_app.Grants.Any(grant => AppDocument.GrantName(grant) is not null))
        {
            await shell.Connection!.FollowAsync(
                "/api/feed",
                project,
                signal =>
                {
                    if (signal is StreamSignal.Received)
                    {
                        Dispatcher.UIThread.Post(() => BoardChanged(cancellationToken));
                    }

                    return Task.CompletedTask;
                },
                cancellationToken: cancellationToken);
        }
    }

    protected override void OnHidden()
    {
        if (Application.Current is { } application)
        {
            application.ActualThemeVariantChanged -= TellColorScheme;
        }

        CloseApp();
        Running = false;
    }

    private void CloseApp()
    {
        _settling?.Cancel();
        _settling?.Dispose();
        _settling = null;
        _broker?.Dispose();
        _broker = null;
        _view = null;
    }

    private void TellColorScheme(object? sender, EventArgs e) =>
        _view?.Send($$"""{"event":"colorScheme","colorScheme":"{{AppDocument.SchemeName(ColorScheme)}}"}""");

    /// <summary>Trailing, because a feed that has just connected replays one event per card.</summary>
    private void BoardChanged(CancellationToken cancellationToken)
    {
        if (cancellationToken.IsCancellationRequested || _view is null)
        {
            return;
        }

        _settling?.Cancel();
        _settling?.Dispose();
        _settling = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _ = TellChangedAsync(_settling.Token);
    }

    private async Task TellChangedAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(Settle, cancellationToken);
            _view?.Send("""{"event":"change"}""");
        }
        catch (OperationCanceledException)
        {
            // A later event took over, or the page was left.
        }
    }
}
