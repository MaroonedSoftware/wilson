using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.Media.Imaging;
using Avalonia.Styling;
using Avalonia.Threading;
using MaroonedSoftware.Wilson.Desktop;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Updates;
using MaroonedSoftware.Wilson.Desktop.Mac;
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
//     dotnet run --project tools/Walk -- keychain
//     dotnet run --project tools/Walk -- update <bundle> <zip> <sig> <public key> <version>
internal static class Program
{
    private const int Width = 1180;
    private const int Height = 760;

    [STAThread]
    public static void Main(string[] args)
    {
        if (args is ["keychain"])
        {
            Keychain();
            return;
        }

        if (args is ["update", var bundle, var zip, var signature, var publicKey, var version])
        {
            Environment.ExitCode = Update(bundle, zip, signature, publicKey, Version.Parse(version)).GetAwaiter().GetResult();
            return;
        }

        AppBuilder.Configure<App>()
            .UseSkia()
            .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false })
            .AfterSetup(_ => Run(args))
            .SetupWithoutStarting();
    }

    /// <summary>Writes, reads, replaces and deletes one throwaway item in the login Keychain.</summary>
    private static void Keychain()
    {
        const string Origin = "wilson-walk-keychain-check";
        var store = new MacKeychainSecretStore();
        var session = new StoredSession { Origin = Origin, Email = "walk@example.com", AccessToken = "a", RefreshToken = "r" };

        store.WriteAsync(session).GetAwaiter().GetResult();
        var read = store.ReadAsync(Origin).GetAwaiter().GetResult();
        store.WriteAsync(session with { RefreshToken = "r2" }).GetAwaiter().GetResult();
        var replaced = store.ReadAsync(Origin).GetAwaiter().GetResult();
        store.DeleteAsync(Origin).GetAwaiter().GetResult();
        var gone = store.ReadAsync(Origin).GetAwaiter().GetResult();

        Console.WriteLine($"read {read == session}, replaced {replaced?.RefreshToken == "r2"}, deleted {gone is null}");
    }

    /// <summary>Installs a release over a bundle the way the app would: verify, unpack, then swap as this process exits.</summary>
    private static async Task<int> Update(string bundle, string zip, string signature, string publicKey, Version version)
    {
        string hash;
        await using (var file = File.OpenRead(zip))
        {
            hash = UpdateSignature.Hash(file);
        }

        var valid = UpdateSignature.IsValid(await File.ReadAllTextAsync(publicKey), version, hash, await File.ReadAllBytesAsync(signature));
        Console.WriteLine($"signature valid: {valid}");
        if (!valid)
        {
            return 1;
        }

        var installer = new MacUpdateInstaller();
        if (await installer.PrepareAsync(zip, bundle) is not { } staging)
        {
            Console.WriteLine("could not unpack");
            return 1;
        }

        installer.SwapAfterExit(staging, bundle);
        return 0;
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

    /// <summary>Text from the keyboard, into whatever has the focus, as a person's would arrive.</summary>
    public void Type(string text)
    {
        Dispatcher.UIThread.RunJobs();
        window.KeyTextInput(text);
    }

    public void Press(Key key, PhysicalKey physical)
    {
        Dispatcher.UIThread.RunJobs();
        window.KeyPressQwerty(physical, RawInputModifiers.None);
        window.KeyReleaseQwerty(physical, RawInputModifiers.None);
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
