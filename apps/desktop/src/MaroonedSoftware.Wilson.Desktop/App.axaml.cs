using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Platform;
using MaroonedSoftware.Wilson.Desktop.Core.Settings;
using MaroonedSoftware.Wilson.Desktop.Core.Updates;
using MaroonedSoftware.Wilson.Desktop.Mac;
using MaroonedSoftware.Wilson.Desktop.ViewModels;
using MaroonedSoftware.Wilson.Desktop.Views;

namespace MaroonedSoftware.Wilson.Desktop;

public partial class App : Application
{
    private UpdateViewModel? _updates;

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var updateHttp = new HttpClient();
            updateHttp.DefaultRequestHeaders.UserAgent.ParseAdd($"wilson-desktop/{UpdateCheck.Current}");
            var key = UpdateSignature.BuiltInKey();
            var downloader = key is null ? null : new UpdateDownloader(updateHttp, key, Path.Combine(Path.GetTempPath(), "wilson-updates"));
            var updates = new UpdateViewModel(new UpdateChecker(updateHttp, UpdateCheck.Current), downloader, new MacUpdateInstaller(), BundleSwap.BundleOf(Environment.ProcessPath), () => desktop.Shutdown());
            _updates = updates;
            var shell = new ShellViewModel(new MacKeychainSecretStore(), DesktopSettings.DefaultPath()) { Updates = updates, ClaudeSignIn = new MacClaudeSignIn() };
            var window = new MainWindow { DataContext = shell };
            desktop.MainWindow = window;
            // Closing only hides, so streams and the update check carry on. Quit and a restart to update
            // close with a shutdown reason and get through.
            desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            window.Closing += (_, e) =>
            {
                if (e.CloseReason is WindowCloseReason.WindowClosing)
                {
                    e.Cancel = true;
                    window.Hide();
                    MacDockIcon.Hide();
                }
            };
            var statusItem = ShowInMenuBar(shell, window, desktop);
            if (TryGetFeature(typeof(IActivatableLifetime)) is IActivatableLifetime activatable)
            {
                // Opening the app again from Finder or Spotlight, or a click on the Dock icon while it is
                // minimised, which would otherwise do nothing.
                activatable.Activated += (_, e) =>
                {
                    if (e.Kind is ActivationKind.Reopen)
                    {
                        Reveal(window);
                    }
                };
            }

            desktop.Exit += (_, _) =>
            {
                statusItem.Dispose();
                shell.Dispose();
                updateHttp.Dispose();
            };
            _ = shell.StartAsync();
            _ = updates.RunAsync();
        }

        base.OnFrameworkInitializationCompleted();
    }

    private void OnAbout(object? sender, EventArgs e) => MacAboutPanel.Show();

    private void OnCheckForUpdates(object? sender, EventArgs e)
    {
        // The answer is in the window's strip, and the menu is there while the window is hidden.
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime { MainWindow: { } window })
        {
            Reveal(window);
        }

        _ = _updates?.CheckNowAsync();
    }

    private static MacStatusItem ShowInMenuBar(ShellViewModel shell, Window window, IClassicDesktopStyleApplicationLifetime desktop)
    {
        MenuBarWindow? panel = null;

        using var image = AssetLoader.Open(new Uri("avares://wilson/Assets/tray.png"));
        using var png = new MemoryStream();
        image.CopyTo(png);
        var item = new MacStatusItem(png.ToArray(), "Wilson", () => panel?.Toggle());

        panel = new MenuBarWindow(item, new MenuBarViewModel(
            shell,
            () =>
            {
                panel?.Dismiss();
                Reveal(window);
            },
            () => desktop.Shutdown()));

        // A panel macOS refused focus has none to lose when this window is pressed.
        window.Activated += (_, _) => panel.Dismiss();
        return item;
    }

    private static void Reveal(Window window)
    {
        MacDockIcon.Show();
        window.Show();
        if (window.WindowState is WindowState.Minimized)
        {
            window.WindowState = WindowState.Normal;
        }

        window.Activate();
    }
}
