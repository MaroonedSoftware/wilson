using Avalonia;

namespace MaroonedSoftware.Wilson.Desktop;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);

    /// <summary>Used by the visual designer as well as by <see cref="Main"/>, so it stays parameterless.</summary>
    public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>().UsePlatformDetect().LogToTrace();
}
