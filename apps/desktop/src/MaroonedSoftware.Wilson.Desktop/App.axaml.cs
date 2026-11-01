using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
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
            desktop.MainWindow = new MainWindow { DataContext = shell };
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
}
