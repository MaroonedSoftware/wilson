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
//     dotnet run --project tools/Walk -- <out dir> <origin> <email> <password> [light|dark] [admin|firstrun|dock]
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
        var only = args.Length > 5 ? args[5] : null;
        Directory.CreateDirectory(into);

        using var finished = new CancellationTokenSource();
        Dispatcher.UIThread.Post(async () =>
        {
            try
            {
                await WalkAsync(into, origin, email, password, appearance, only);
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

    private static async Task WalkAsync(string into, string origin, string email, string password, Appearance appearance, string? only)
    {
        // A fresh file each run, because a walk begins at the first-run sign-in.
        var settings = Path.Combine(into, "settings.json");
        // Every other walk closes the dock, so its pages keep the whole window as their steps expect.
        new DesktopSettings { Appearance = appearance, Dock = new ChatDock { Closed = only != "dock" } }.Save(settings);
        using var shell = new ShellViewModel(new InMemorySecretStore(), settings);
        var window = new Window { Width = Width, Height = Height, Content = new ShellView { DataContext = shell } };
        window.Show();

        await shell.StartAsync();
        await (only == "firstrun"
            ? Steps.FirstRunAsync(new Walker(into, window, shell), origin, email, password)
            : Steps.RunAsync(new Walker(into, window, shell), origin, email, password, only));
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

    /// <summary>One value out of the throwaway API's database.</summary>
    public static string Query(string sql)
    {
        using var psql = Process.Start(new ProcessStartInfo("docker", ["exec", "wilson-test-db", "psql", "-U", "postgres", "-d", "wilson_android", "-qtAc", sql]) { RedirectStandardOutput = true })!;
        var value = psql.StandardOutput.ReadToEnd().Trim();
        psql.WaitForExit();
        return value;
    }

    /// <summary>A branch in the throwaway API's scratch repository, as a stage would leave, with one small file on it.</summary>
    public static void ScratchBranch(string branch)
    {
        const string Root = "$(docker exec wilson-test-db psql -U postgres -d wilson_android -qtAc \"select code_root from wilson.projects limit 1\")";
        var script = $"cd \"{Root}\" && git rev-parse -q --verify {branch} >/dev/null || {{ d=$(mktemp -d) && git worktree add -q -b {branch} \"$d\" main && printf 'one\\ntwo\\nthree\\n' > \"$d/walk.txt\" && git -C \"$d\" add walk.txt && git -C \"$d\" -c user.name=walk -c user.email=walk@example.com commit -qm walk && git worktree remove --force \"$d\"; }}";
        using var shell = Process.Start("sh", ["-c", script]);
        shell.WaitForExit();
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

    /// <summary>The code an authenticator app shows now, as RFC 6238 and the API's defaults have it.</summary>
    public static string Totp(string secret)
    {
        const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        var key = new List<byte>();
        var (buffer, bits) = (0, 0);
        foreach (var letter in secret.TrimEnd('=').ToUpperInvariant())
        {
            buffer = (buffer << 5) | Alphabet.IndexOf(letter, StringComparison.Ordinal);
            bits += 5;
            if (bits >= 8)
            {
                bits -= 8;
                key.Add((byte)(buffer >> bits));
                buffer &= (1 << bits) - 1;
            }
        }

        var counter = BitConverter.GetBytes(DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30);
        Array.Reverse(counter);
#pragma warning disable CA5350 // SHA-1 is what RFC 6238 and the server use.
        var hash = System.Security.Cryptography.HMACSHA1.HashData(key.ToArray(), counter);
#pragma warning restore CA5350
        var at = hash[^1] & 0xf;
        var number = ((hash[at] & 0x7f) << 24) | (hash[at + 1] << 16) | (hash[at + 2] << 8) | hash[at + 3];
        return (number % 1_000_000).ToString("D6", System.Globalization.CultureInfo.InvariantCulture);
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

    /// <summary>A shortcut, as the window would receive it, whatever has the focus.</summary>
    public void Chord(PhysicalKey physical, RawInputModifiers modifiers)
    {
        Dispatcher.UIThread.RunJobs();
        window.KeyPressQwerty(physical, modifiers);
        window.KeyReleaseQwerty(physical, modifiers);
        Dispatcher.UIThread.RunJobs();
    }

    /// <summary>The middle of the control of that name.</summary>
    public Point CenterOf(string name)
    {
        Dispatcher.UIThread.RunJobs();
        var control = window.GetVisualDescendants().OfType<Control>().First(found => found.Name == name);
        return control.TranslatePoint(new Point(control.Bounds.Width / 2, control.Bounds.Height / 2), window) ?? throw new InvalidOperationException("not on screen");
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

    /// <summary>Scrolls the first block reading `text` to the top of its scroller, for a look further down a page.</summary>
    public void ScrollTo(string text)
    {
        Dispatcher.UIThread.RunJobs();
        var block = window.GetVisualDescendants().OfType<TextBlock>().First(found => found.Text == text);
        var scroller = block.GetVisualAncestors().OfType<ScrollViewer>().First();
        var top = block.TranslatePoint(default, (Visual)scroller.Content!)!.Value.Y;
        scroller.Offset = new Vector(0, top);
        Dispatcher.UIThread.RunJobs();
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

    private static string Written(SelectableTextBlock block) => string.Concat(block.Inlines!.Select(inline => inline is Run run ? run.Text : "\n"));

    /// <summary>A real press on `text` where it first shows in a block of Markdown, as a person would follow a link.</summary>
    public void ClickText(string text)
    {
        Dispatcher.UIThread.RunJobs();
        foreach (var block in window.GetVisualDescendants().OfType<SelectableTextBlock>().Where(block => block.Inlines is not null))
        {
            var index = Written(block).IndexOf(text, StringComparison.Ordinal);
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

    /// <summary>A real drag across `text` in a block of Markdown, as a person would select a passage.</summary>
    public void Select(string text)
    {
        Dispatcher.UIThread.RunJobs();
        var block = window.GetVisualDescendants().OfType<SelectableTextBlock>().First(found => found.Inlines is not null && Written(found).Contains(text, StringComparison.Ordinal));
        var index = Written(block).IndexOf(text, StringComparison.Ordinal);
        block.BringIntoView();
        Dispatcher.UIThread.RunJobs();
        var from = block.TranslatePoint(block.TextLayout.HitTestTextPosition(index).TopLeft + new Point(0.5, 6), window)!.Value;
        var to = block.TranslatePoint(block.TextLayout.HitTestTextPosition(index + text.Length).TopLeft + new Point(0.5, 6), window)!.Value;
        Drag(from, to);
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
            window.MouseMove(from + ((to - from) * step / Steps), RawInputModifiers.LeftMouseButton);
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
