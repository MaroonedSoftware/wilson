using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;
using MaroonedSoftware.Wilson.Desktop;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.ViewModels;
using MaroonedSoftware.Wilson.Desktop.Views;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace Walk;

// An installed app opened the way a person opens one, in a real window with the real web view, through the
// real shell against a real API. It installs its own apps and removes them, so point it only at the throwaway
// API. The pictures are the proof, so Read them. It cannot run in the Bash sandbox.
//
//     dotnet run --project tools/Walk -- app-live <out dir> <origin> <email> <password>
internal static class AppLive
{
    /// <summary>Draws what it could read, and what it was refused, in the page, as an app has nowhere else to say it.</summary>
    private const string Reader = """
        <!doctype html><html><body style="font:15px system-ui;margin:12px"><h3>Reader</h3><pre id="out" style="white-space:pre-wrap"></pre>
        <script>
        const out = document.getElementById('out');
        const say = (k, v) => { out.textContent += k + ': ' + v + '\n'; };
        say('project', wilson.project); say('grants', wilson.grants.join()); say('scheme', wilson.colorScheme); say('origin', self.origin);
        const ask = async (k, f) => { try { say(k, 'ANSWERED ' + await f()); } catch (e) { say(k, 'refused: ' + e.message); } };
        (async () => {
            await ask('listCards', async () => (await wilson.listCards()).map(c => c.id + ' ' + c.title).join(' | '));
            await ask('listBoardColumns', async () => (await wilson.listBoardColumns()).stages.join());
            await ask('listProjectActivity', async () => (await wilson.listProjectActivity({ limit: 1 })).length);
            await ask('getProjectStats', async () => JSON.stringify(await wilson.getProjectStats({ days: 1 })).slice(0, 60));
            await ask('getCard(..)', () => wilson.getCard('..'));
            try { localStorage.x = 1; say('localStorage', 'WORKS'); } catch (e) { say('localStorage', e.name); }
            try { await fetch('http://127.0.0.1:9/'); say('fetch', 'WORKS'); } catch (e) { say('fetch', e.name); }
            say('RTCPeerConnection', typeof RTCPeerConnection);
        })();
        let changes = 0;
        wilson.onChange(() => { changes += 1; document.title = changes; say('change', changes); });
        wilson.onColorSchemeChange(s => say('scheme now', s));
        </script></body></html>
        """;

    private const string Leaver = """
        <!doctype html><html><body>Leaving soon<script>setTimeout(() => { location.href = 'http://127.0.0.1:18999/leak?secret=1'; }, 500);</script></body></html>
        """;

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
        var shell = new ShellViewModel(new InMemorySecretStore(), Path.Combine(Directory.CreateTempSubdirectory("wilson-app-live-").FullName, "settings.json"));
        var connection = shell.Connect(origin);
        Console.WriteLine($"sign-in: {await connection.Session.SignInAsync(email, password)}");
        var window = new Window { Width = 1000, Height = 640, Position = new PixelPoint(60, 60), Title = "app-live", Content = new ShellView { DataContext = shell } };
        window.Show();

        var apps = connection.Sdk.Apps;
        await apps.InstallAppAsync("walk-reader", new InstallAppRequest { Name = "Walk reader", Description = "Reads the board and nothing else", Html = Reader, Grants = [AppGrant.BoardRead] });
        await apps.InstallAppAsync("walk-leaver", new InstallAppRequest { Name = "Walk leaver", Html = Leaver, Grants = [] });
        try
        {
            var projects = await connection.Sdk.Projects.ListProjectsAsync();
            Console.WriteLine($"projects: {string.Join(", ", projects.Select(project => project.Name))}");
            // Two projects, each with a card of its own, so a picture can show the app reading only the one it was opened in.
            var shown = projects.Select(project => project.Name).OrderBy(name => name == "wilson" ? 0 : 1).Take(2).ToList();
            var cards = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var name in shown)
            {
                using var sdk = connection.ForProject(name);
                cards[name] = (await sdk.Board.CreateCardAsync(new CreateCardRequest { Title = $"Only in {name}", Body = "by app-live" })).Id;
            }

            foreach (var name in shown)
            {
                shell.ShowProject(name);
                await Task.Delay(1500);
                Shot(window, outDir, $"header-{name}");
                shell.ShowAppsCommand.Execute(null);
                await Task.Delay(800);
                Shot(window, outDir, $"apps-{name}");
                ((AppsViewModel)shell.Page!).Open("walk-reader");
                await Task.Delay(3000);
                Shot(window, outDir, $"reader-{name}");
                shell.Back();
                shell.Back();
                shell.ShowBoard();
            }

            // A move on the board, which reaches an app with a grant through the feed, and a change of scheme.
            var first = shown[0];
            shell.ShowProject(first);
            await Task.Delay(1000);
            shell.ShowAppsCommand.Execute(null);
            await Task.Delay(500);
            ((AppsViewModel)shell.Page!).Open("walk-reader");
            await Task.Delay(2500);
            shell.NextAppearanceCommand.Execute(null);
            shell.NextAppearanceCommand.Execute(null);
            await Task.Delay(800);
            using (var sdk = connection.ForProject(first))
            {
                await sdk.Board.MoveCardAsync(cards[first], new MoveCardRequest { Stage = "planning" });
            }

            await Task.Delay(2000);
            Shot(window, outDir, "reader-after-events");
            shell.Back();
            await Task.Delay(300);

            ((AppsViewModel)shell.Page!).Open("walk-leaver");
            var leaver = (AppViewModel)shell.Page!;
            await Task.Delay(2500);
            Shot(window, outDir, "leaver-closed");
            Console.WriteLine($"leaver left: {leaver.Left}, still running: {leaver.Running}");
            leaver.OpenAgain();
            await Task.Delay(300);
            Console.WriteLine($"opened again, running: {leaver.Running}");
            await Task.Delay(2000);
            Console.WriteLine($"left again: {leaver.Left}");
            return leaver.Left ? 0 : 1;
        }
        finally
        {
            await apps.RemoveAppAsync("walk-reader");
            await apps.RemoveAppAsync("walk-leaver");
            window.Close();
        }
    }

    /// <summary>The window as the screen has it, as the page is drawn by another process and no in-app render can see it.</summary>
    private static void Shot(Window window, string outDir, string name)
    {
        var size = window.ClientSize;
        var at = window.Position;
        var scale = window.DesktopScaling;
        using var capture = Process.Start("/usr/sbin/screencapture", ["-x", "-R", $"{at.X / scale},{at.Y / scale},{size.Width},{size.Height + 28}", Path.Combine(outDir, $"{name}.png")]);
        capture.WaitForExit();
    }
}
