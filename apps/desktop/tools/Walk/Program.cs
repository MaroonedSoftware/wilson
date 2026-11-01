using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Media.Imaging;
using Avalonia.Styling;
using Avalonia.Threading;
using MaroonedSoftware.Wilson.Desktop;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.ViewModels;
using MaroonedSoftware.Wilson.Desktop.Views;

namespace Walk;

// Walks the real app against a real API with no screen, rendering each step to a PNG.
//
// The app's own view models and views, on Avalonia's headless platform with real Skia drawing, so
// the requests are real and a picture is what a window would show. Run it against the throwaway API
// (apps/android/tools/api.sh) and never the real board: it changes cards.
//
//     dotnet run --project tools/Walk -- <out dir> <origin> <email> <password> [light|dark]
internal static class Program
{
    private const int Width = 1180;
    private const int Height = 760;

    [STAThread]
    public static void Main(string[] args)
    {
        AppBuilder.Configure<App>()
            .UseSkia()
            .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false })
            .AfterSetup(_ => Run(args))
            .SetupWithoutStarting();
    }

    private static void Run(string[] args)
    {
        var (into, origin, email, password) = (args[0], args[1], args[2], args[3]);
        Application.Current!.RequestedThemeVariant = args.Length > 4 && args[4] == "light" ? ThemeVariant.Light : ThemeVariant.Dark;
        Directory.CreateDirectory(into);

        using var finished = new CancellationTokenSource();
        Dispatcher.UIThread.Post(async () =>
        {
            try
            {
                await WalkAsync(into, origin, email, password);
            }
            catch (Exception failure)
            {
                await Console.Error.WriteLineAsync($"FAILED: {failure}");
                Environment.ExitCode = 1;
            }
            finally
            {
                await finished.CancelAsync();
            }
        });
        Dispatcher.UIThread.MainLoop(finished.Token);
    }

    private static async Task WalkAsync(string into, string origin, string email, string password)
    {
        using var shell = new ShellViewModel(new InMemorySecretStore(), Path.Combine(into, "settings.json"));
        var window = new Window { Width = Width, Height = Height, Content = new ShellView { DataContext = shell } };
        window.Show();

        await shell.StartAsync();
        await Steps.RunAsync(new Walker(into, window, shell), origin, email, password);
        window.Close();
    }
}

/// <summary>What a step can do: wait for the app to reach a state, and look at it.</summary>
internal sealed class Walker(string into, Window window, ShellViewModel shell)
{
    public ShellViewModel Shell => shell;

    public T Page<T>()
        where T : PageViewModel => shell.Page as T ?? throw new InvalidOperationException($"expected {typeof(T).Name}, on {shell.Page?.GetType().Name}");

    public async Task UntilAsync(string what, Func<bool> done, int seconds = 20)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (!done())
        {
            if (DateTime.UtcNow > deadline)
            {
                throw new TimeoutException($"never saw: {what}");
            }

            await Task.Delay(50);
        }

        Console.WriteLine($"ok   {what} ({shell.Page?.GetType().Name})");
    }

    public void Shot(string name)
    {
        Dispatcher.UIThread.RunJobs();
        Dispatcher.UIThread.RunJobs();
        Dispatcher.UIThread.RunJobs();
        using var frame = window.CaptureRenderedFrame();
        frame?.Save(Path.Combine(into, $"{name}.png"), new PngBitmapEncoderOptions());
        Console.WriteLine($"shot {name}");
    }
}
