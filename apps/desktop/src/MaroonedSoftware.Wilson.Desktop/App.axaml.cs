using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using MaroonedSoftware.Wilson.Desktop.Core.Settings;
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
            var shell = new ShellViewModel(new MacKeychainSecretStore(), DesktopSettings.DefaultPath());
            desktop.MainWindow = new MainWindow { DataContext = shell };
            desktop.Exit += (_, _) => shell.Dispose();
            _ = shell.StartAsync();
        }

        base.OnFrameworkInitializationCompleted();
    }
}
