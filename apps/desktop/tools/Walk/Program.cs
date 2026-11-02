using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using MaroonedSoftware.Wilson.Desktop;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Settings;
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
        var appearance = args.Length > 4 && args[4] == "light" ? Appearance.Light : Appearance.Dark;
        Directory.CreateDirectory(into);

        using var finished = new CancellationTokenSource();
        Dispatcher.UIThread.Post(async () =>
        {
            try
            {
                await WalkAsync(into, origin, email, password, appearance);
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

    private static async Task WalkAsync(string into, string origin, string email, string password, Appearance appearance)
    {
        // A fresh file each run, because a walk begins at the first-run sign-in.
        var settings = Path.Combine(into, "settings.json");
        new DesktopSettings { Appearance = appearance }.Save(settings);
        using var shell = new ShellViewModel(new InMemorySecretStore(), settings);
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

    /// <summary>What a relaunch would read.</summary>
    public DesktopSettings Settings() => DesktopSettings.Load(Path.Combine(into, "settings.json"));

    /// <summary>
    /// Writes an event as a running stage would, on the throwaway API's own database. The feed reads
    /// a Postgres notification, so this is the real path and only the writer is posed.
    /// </summary>
    public static void Emit(string card, string stage, string type, string payload)
    {
        var sql = $"with made as (insert into wilson.card_events (project, card_id, stage, type, payload) select project, id, '{stage}', '{type}', '{payload}'::jsonb from wilson.cards where id = '{card}' returning *) "
            + "select pg_notify('card_events', json_build_object('id', id::text, 'project', project, 'cardId', card_id, 'stage', stage, 'type', type)::text) from made";
        Sql(sql);
    }

    /// <summary>Only ever the throwaway API's database, for what no request can pose.</summary>
    public static void Sql(string sql)
    {
        using var psql = Process.Start("docker", ["exec", "wilson-test-db", "psql", "-U", "postgres", "-d", "wilson_android", "-qtAc", sql]);
        psql.WaitForExit();
    }

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

    /// <summary>The middle of whatever a view drew for `model`, in the window's coordinates.</summary>
    public Point Center(object model)
    {
        Dispatcher.UIThread.RunJobs();
        var control = window.GetVisualDescendants().OfType<Control>().First(found => found.DataContext == model && found is Button or Border);
        control.BringIntoView();
        Dispatcher.UIThread.RunJobs();
        return control.TranslatePoint(new Point(control.Bounds.Width / 2, control.Bounds.Height / 2), window) ?? throw new InvalidOperationException("not on screen");
    }

    /// <summary>A press and release in one place, through Avalonia's input like a person's.</summary>
    public void Click(Point at)
    {
        Dispatcher.UIThread.RunJobs();
        window.MouseMove(at);
        window.MouseDown(at, MouseButton.Left);
        window.MouseUp(at, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
    }

    /// <summary>A real press on `text` where it first shows in a block of Markdown, as a person would follow a link.</summary>
    public void ClickText(string text)
    {
        Dispatcher.UIThread.RunJobs();
        foreach (var block in window.GetVisualDescendants().OfType<SelectableTextBlock>().Where(block => block.Inlines is not null))
        {
            var written = string.Concat(block.Inlines!.Select(inline => inline is Run run ? run.Text : "\n"));
            var index = written.IndexOf(text, StringComparison.Ordinal);
            if (index >= 0)
            {
                block.BringIntoView();
                Dispatcher.UIThread.RunJobs();
                var spot = block.TextLayout.HitTestTextPosition(index + 1).Center;
                Click(block.TranslatePoint(spot, window) ?? throw new InvalidOperationException("not on screen"));
                return;
            }
        }

        throw new InvalidOperationException($"no {text} on screen");
    }

    /// <summary>A press that stays down, for what happens during one.</summary>
    public void Down(Point at)
    {
        Dispatcher.UIThread.RunJobs();
        window.MouseMove(at);
        window.MouseDown(at, MouseButton.Left);
    }

    public void MoveTo(Point at)
    {
        window.MouseMove(at);
        Dispatcher.UIThread.RunJobs();
    }

    public void Up(Point at)
    {
        window.MouseUp(at, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
    }

    /// <summary>A press, a move in steps, and a release, shooting the middle of the drag if named.</summary>
    public void Drag(Point from, Point to, string? shot = null)
    {
        const int Steps = 6;
        Dispatcher.UIThread.RunJobs();
        window.MouseMove(from);
        window.MouseDown(from, MouseButton.Left);
        for (var step = 1; step <= Steps; step++)
        {
            window.MouseMove(from + ((to - from) * step / Steps));
            Dispatcher.UIThread.RunJobs();
        }

        if (shot is not null)
        {
            Shot(shot);
        }

        window.MouseUp(to, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
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
