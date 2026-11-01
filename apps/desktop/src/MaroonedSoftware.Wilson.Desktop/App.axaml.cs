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
            var shell = new ShellViewModel(new MacKeychainSecretStore(), DesktopSettings.DefaultPath()) { Updates = updates };
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
                }
            };
            ShowInMenuBar(window, desktop);
            if (TryGetFeature(typeof(IActivatableLifetime)) is IActivatableLifetime activatable)
            {
                // A click on the Dock icon, which would otherwise do nothing while the window is hidden.
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
                shell.Dispose();
                updateHttp.Dispose();
            };
            _ = shell.StartAsync();
            _ = updates.RunAsync();
        }

        base.OnFrameworkInitializationCompleted();
    }

    private void OnAbout(object? sender, EventArgs e) => MacAboutPanel.Show();

    private void ShowInMenuBar(Window window, IClassicDesktopStyleApplicationLifetime desktop)
    {
        var open = new NativeMenuItem("Open Wilson");
        open.Click += (_, _) => Reveal(window);
        var quit = new NativeMenuItem("Quit Wilson");
        quit.Click += (_, _) => desktop.Shutdown();

        using var image = AssetLoader.Open(new Uri("avares://wilson/Assets/tray.png"));
        var tray = new TrayIcon
        {
            Icon = new WindowIcon(image),
            ToolTipText = "Wilson",
            Menu = new NativeMenu { open, new NativeMenuItemSeparator(), quit },
        };
        MacOSProperties.SetIsTemplateIcon(tray, true);
        TrayIcon.SetIcons(this, [tray]);
    }

    private static void Reveal(Window window)
    {
        window.Show();
        if (window.WindowState is WindowState.Minimized)
        {
            window.WindowState = WindowState.Normal;
        }

        window.Activate();
    }
}
