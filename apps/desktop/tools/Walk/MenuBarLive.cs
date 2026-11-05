using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Platform;
using Avalonia.Threading;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Mac;
using MaroonedSoftware.Wilson.Desktop.ViewModels;
using MaroonedSoftware.Wilson.Desktop.Views;

namespace Walk;

// The menu bar icon and its panel in real windows, against a real API, which the headless walk has neither
// of. A press here is AppKit's own, through the button's target and action. It puts a second icon in the
// menu bar and tries to take focus while it runs. macOS may refuse focus to a process started in the background,
// which no real press meets, so what depends on it is skipped and says so. It cannot run in the Bash sandbox.
//
//     dotnet run --project tools/Walk -- menubar-live <out dir> <origin> <email> <password>
internal static class MenuBarLive
{
    public static int Run(string outDir, string origin, string email, string password)
    {
        var code = 1;
        AppBuilder.Configure<MaroonedSoftware.Wilson.Desktop.App>()
            .UsePlatformDetect()
            .Start((app, _) =>
            {
                using var stop = new CancellationTokenSource();
                Dispatcher.UIThread.Post(async () =>
                {
                    try
                    {
                        code = await WalkAsync(outDir, origin, email, password);
                    }
                    catch (Exception failure)
                    {
                        Console.WriteLine(failure);
                    }

                    stop.Cancel();
                });
                app.Run(stop.Token);
            }, []);
        return code;
    }

    private static async Task<int> WalkAsync(string outDir, string origin, string email, string password)
    {
        Directory.CreateDirectory(outDir);
        var failures = 0;
        void Check(string what, bool holds)
        {
            Console.WriteLine($"{(holds ? "ok  " : "FAIL")} {what}");
            failures += holds ? 0 : 1;
        }

        using var shell = new ShellViewModel(new InMemorySecretStore(), Path.Combine(Directory.CreateTempSubdirectory("wilson-menubar-live-").FullName, "settings.json"));
        var connection = shell.Connect(origin);
        Console.WriteLine($"sign-in: {await connection.Session.SignInAsync(email, password)}");
        shell.ShowChat();
        var main = new Window { Width = 500, Height = 300, Position = new PixelPoint(60, 120), Title = "menubar-live", Content = new ShellView { DataContext = shell } };
        main.Show();

        using var image = AssetLoader.Open(new Uri("avares://wilson/Assets/tray.png"));
        using var png = new MemoryStream();
        image.CopyTo(png);
        MenuBarWindow? window = null;
        var revealed = 0;
        using var item = new MacStatusItem(png.ToArray(), "Wilson (walk)", () => window?.Toggle());
        var panel = new MenuBarViewModel(shell, () => { window?.Dismiss(); revealed++; }, () => { });
        window = new MenuBarWindow(item, panel);

        // The bar lays the icon out on its next pass, and a person cannot press it before that either.
        await Task.Delay(500);
        item.Press();
        await UntilAsync(() => window.IsVisible && panel.HasFigures);
        Check("a press opens the panel and it reads", window.IsVisible && panel.HasFigures);
        await Task.Delay(500);
        var top = window.Position.Y;
        Console.WriteLine($"panel at {window.Position}, {window.Bounds.Width}x{window.Bounds.Height}, on {window.Screens.ScreenFromWindow(window)?.WorkingArea}");
        var area = window.Screens.ScreenFromWindow(window)?.WorkingArea;
        Check("it hangs from the top of the screen", area is { } working && Math.Abs(top - working.Y) < 20 * (window.Screens.ScreenFromWindow(window)?.Scaling ?? 1));
        Check("it fits its content rather than filling the screen", window.Bounds.Height is > 200 and < 720);
        Capture(outDir, "panel", window);

        item.Press();
        await UntilAsync(() => !window.IsVisible);
        Check("a second press closes it", !window.IsVisible);

        await Task.Delay(400);
        item.Press();
        await UntilAsync(() => window.IsVisible);
        Check("a third press opens it again", window.IsVisible);
        await Task.Delay(300);
        if (window.IsActive)
        {
            main.Activate();
            await UntilAsync(() => !window.IsVisible);
            Check("another window taking focus dismisses it", !window.IsVisible);
        }
        else
        {
            Console.WriteLine("skip macOS refused focus, so losing it could not be tried");
            window.Dismiss();
        }

        // As the app is once its window is closed: no Dock icon, no menu, nothing active.
        main.Hide();
        MacDockIcon.Hide();
        await Task.Delay(400);
        item.Press();
        await UntilAsync(() => window.IsVisible);
        await UntilAsync(() => window.IsActive, seconds: 2);
        Check("with the app hidden, a press still opens it", window.IsVisible);
        Console.WriteLine($"     focus: {window.IsActive}");
        await Task.Delay(300);
        Capture(outDir, "panel-app-hidden", window);
        panel.OpenWilson();
        Check("Open Wilson closes it and asks for the window", !window.IsVisible && revealed == 1);
        MacDockIcon.Show();

        window.Close();
        main.Close();
        return failures;
    }

    private static async Task UntilAsync(Func<bool> done, int seconds = 15)
    {
        for (var waited = 0; waited < seconds * 10 && !done(); waited++)
        {
            await Task.Delay(100);
        }
    }

    /// <summary>Only the panel's part of the screen. Needs Screen Recording permission; without it, says so and carries on.</summary>
    private static void Capture(string outDir, string name, Window window)
    {
        var scale = window.Screens.ScreenFromWindow(window)?.Scaling ?? 1;
        var path = Path.Combine(outDir, $"{name}.png");
        var region = FormattableString.Invariant($"{(int)(window.Position.X / scale) - 40},0,{(int)window.Bounds.Width + 80},{(int)window.Bounds.Height + 60}");
        using var capture = Process.Start(new ProcessStartInfo("/usr/sbin/screencapture", ["-x", "-R", region, path]) { RedirectStandardError = true })!;
        capture.WaitForExit();
        Console.WriteLine($"capture {name}: {(capture.ExitCode == 0 ? path : capture.StandardError.ReadToEnd())}");
    }
}
