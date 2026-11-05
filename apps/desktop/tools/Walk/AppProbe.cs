using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;
using MaroonedSoftware.Wilson.Desktop.Core.Apps;
using MaroonedSoftware.Wilson.Desktop.Mac;
using MaroonedSoftware.Wilson.Desktop.Views;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace Walk;

// Runs an app built to escape in the real web view, in a real window, against a server that logs every
// connection and datagram, with each lock off and then all of them on. The runs with locks off are the
// positive control: they prove each way out reaches the server, so nothing arriving later means it was
// stopped rather than that it never worked. Needs the real platform, so it opens a window for a few minutes,
// and it cannot run in the Bash sandbox.
//
//     dotnet run --project tools/Walk -- app-probe
internal static class AppProbe
{
    private static readonly TimeSpan RunTime = TimeSpan.FromSeconds(2.6);

    /// <summary>Ways out that make no navigation. Each is a path the server should see from an app with no policy.</summary>
    private static readonly string[] Requests = ["fetch", "xhr", "beacon", "img", "script", "style", "cssimport", "cssbg", "font", "ws", "es", "video", "preload", "object", "embed", "svgimage", "nestedIframe", "nestedSrcdoc"];

    private static readonly string[] Ways = ["ping", "form", "anchorBlank", "anchorNamed", "anchorWindow", "areaBlank", "topnav", "parentnav", "metarefresh", "custom", "datanav", "blobnav", "download", "selfnav", "replace", "srcdocreload"];

    private static readonly (string Name, bool Policy, AppWebLocks Locks)[] Layers =
    [
        ("bare", false, AppWebLocks.None),
        ("policy", true, AppWebLocks.None),
        ("+frame-src", true, AppWebLocks.HostPolicy),
        ("+delegate", true, AppWebLocks.Navigation),
        ("all", true, AppWebLocks.All),
    ];

    public static int Run()
    {
        var code = 1;
        AppBuilder.Configure<Application>()
            .UsePlatformDetect()
            .Start((app, _) =>
            {
                app.Styles.Add(new FluentTheme());
                using var stop = new CancellationTokenSource();
                Dispatcher.UIThread.Post(async () =>
                {
                    try
                    {
                        code = await ProbeAsync();
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

    private static async Task<int> ProbeAsync()
    {
        using var server = new LoggingServer();
        var hostile = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "hostile-app.html"))
            .Replace("__TCP__", server.TcpPort.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
            .Replace("__UDP__", server.UdpPort.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
        var window = new Window { Width = 520, Height = 360, Title = "app-probe" };
        window.Show();
        var failed = false;

        // Every locked run first, in a process that has not yet run an unlocked page, so a straggling
        // connection from a control cannot be counted against a lock or hide behind one.
        var locked = await OneAsync(window, server, hostile, "none", Layers[^1]);
        var lockedWays = new Dictionary<string, Outcome>(StringComparer.Ordinal);
        foreach (var way in Ways)
        {
            lockedWays[way] = await OneAsync(window, server, hostile, way, Layers[^1]);
        }

        Console.WriteLine("Staying put, the ways that make no navigation:");
        var control = await OneAsync(window, server, hostile, "none", Layers[0]);
        var missing = Requests.Where(request => !control.Hits.Any(hit => hit.Contains($"/leak/{request}", StringComparison.Ordinal))).ToList();
        Console.WriteLine($"  control, no policy and no locks: {control.Hits.Count} arrived. Expected but missing: {(missing.Count == 0 ? "none" : string.Join(", ", missing))}");
        Console.WriteLine($"  control, WebRTC datagrams: {control.Hits.Count(hit => hit.StartsWith("udp", StringComparison.Ordinal))}");
        failed |= missing.Count > 0 || !control.Hits.Any(hit => hit.StartsWith("udp", StringComparison.Ordinal));

        var policy = await OneAsync(window, server, hostile, "none", Layers[1]);
        Console.WriteLine($"  the document's policy alone: {string.Join(", ", policy.Hits.Distinct())}");
        failed |= !policy.Hits.Contains("tcp (no bytes)") || !policy.Hits.Any(hit => hit.StartsWith("udp", StringComparison.Ordinal));
        Console.WriteLine($"  every lock on: {locked.Hits.Count} arrived {string.Join(", ", locked.Hits)}");
        failed |= locked.Hits.Count > 0;

        Console.WriteLine();
        Console.WriteLine("What the app found, every lock on:");
        foreach (var (key, value) in locked.Report.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            Console.WriteLine($"  {key,-20} {value}");
        }

        Console.WriteLine();
        Console.WriteLine($"What the broker was asked for, granted only board.read: {string.Join(", ", locked.Calls)}");
        failed |= !locked.Calls.Order(StringComparer.Ordinal).SequenceEqual(["getCard:0001", "listCards"], StringComparer.Ordinal);

        Console.WriteLine();
        Console.WriteLine("Trying to leave, requests that reached the server, and whether the app was closed (*):");
        Console.WriteLine($"  {"way",-14}" + string.Concat(Layers.Select(layer => $"{layer.Name,12}")));
        var arrived = new List<string>();
        foreach (var way in Ways)
        {
            var row = new StringBuilder($"  {way,-14}");
            foreach (var layer in Layers)
            {
                var run = layer.Locks == AppWebLocks.All ? lockedWays[way] : await OneAsync(window, server, hostile, way, layer);
                var hits = run.Hits.Count(hit => hit.Contains($"/leak/{way}", StringComparison.Ordinal));
                row.Append($"{hits}{(run.Left ? "*" : string.Empty)}".PadLeft(12));
                if (layer.Locks == AppWebLocks.All && run.Hits.Count > 0)
                {
                    failed = true;
                    arrived.Add($"{way}: {string.Join(", ", run.Hits)}");
                }

                if (way == "selfnav" && layer.Name == "policy" && hits == 0)
                {
                    failed = true;
                    arrived.Add("the control for leaving never left");
                }
            }

            Console.WriteLine(row);
        }

        window.Close();
        foreach (var line in arrived)
        {
            Console.WriteLine($"  arrived with every lock on, {line}");
        }

        Console.WriteLine();
        Console.WriteLine(failed ? "FAILED" : "Nothing got out with every lock on, and the control got out.");
        return failed ? 1 : 0;
    }

    private static async Task<Outcome> OneAsync(Window window, LoggingServer server, string hostile, string way, (string Name, bool Policy, AppWebLocks Locks) layer)
    {
        server.Clear();
        var html = hostile.Replace("__WAY__", way, StringComparison.Ordinal);
        var document = layer.Policy ? AppDocument.Build(html, "demo", [AppGrant.BoardRead], AppColorScheme.Dark) : html;
        var outcome = new Outcome();
        var reads = new RecordingReads();
        MacAppWebView? view = null;
        using var answering = new AppBroker([AppGrant.BoardRead], reads, answer => view?.Send(answer));
        window.Content = new AppWebHost(() =>
        {
            view = new MacAppWebView(document, AppColorScheme.Dark, layer.Locks);
            view.Left += () => outcome.Left = true;
            view.Failed += reason => Console.WriteLine($"  failed: {reason}");
            view.Received += message =>
            {
                using var parsed = JsonDocument.Parse(message);
                if (parsed.RootElement.TryGetProperty("report", out var report))
                {
                    outcome.Report = report.EnumerateObject().ToDictionary(field => field.Name, field => field.Value.ToString(), StringComparer.Ordinal);
                }

                _ = answering.ReceiveAsync(message);
            };
            return view;
        });
        await Task.Delay(RunTime);
        window.Content = null;
        await Task.Delay(100);
        outcome.Hits = server.Hits;
        outcome.Calls = reads.Calls;
        return outcome;
    }

    private sealed class Outcome
    {
        public bool Left { get; set; }

        public IReadOnlyList<string> Hits { get; set; } = [];

        public IReadOnlyList<string> Calls { get; set; } = [];

        public Dictionary<string, string> Report { get; set; } = [];
    }

    private sealed class RecordingReads : IAppReads
    {
        private readonly List<string> _calls = [];

        public IReadOnlyList<string> Calls => _calls;

        public Task<string> ListCardsAsync(CancellationToken cancellationToken) => Answer("listCards");

        public Task<string> GetCardAsync(string id, CancellationToken cancellationToken) => Answer($"getCard:{id}");

        public Task<string> ListBoardColumnsAsync(CancellationToken cancellationToken) => Answer("listBoardColumns");

        public Task<string> ListProjectActivityAsync(long? limit, long? before, CancellationToken cancellationToken) => Answer("listProjectActivity");

        public Task<string> GetProjectStatsAsync(long? days, CancellationToken cancellationToken) => Answer("getProjectStats");

        private Task<string> Answer(string call)
        {
            _calls.Add(call);
            return Task.FromResult("""[{"id":"0001"}]""");
        }
    }

    /// <summary>Counts a TCP connection even if it sends nothing, and every datagram.</summary>
    private sealed class LoggingServer : IDisposable
    {
        private readonly TcpListener _tcp = new(IPAddress.Loopback, 0);
        private readonly UdpClient _udp = new(new IPEndPoint(IPAddress.Loopback, 0));
        private readonly CancellationTokenSource _stop = new();
        private readonly List<string> _hits = [];
        private int _run;

        public LoggingServer()
        {
            _tcp.Start();
            TcpPort = ((IPEndPoint)_tcp.LocalEndpoint).Port;
            UdpPort = ((IPEndPoint)_udp.Client.LocalEndPoint!).Port;
            _ = AcceptAsync();
            _ = ReceiveAsync();
        }

        public int TcpPort { get; }

        public int UdpPort { get; }

        public IReadOnlyList<string> Hits
        {
            get
            {
                lock (_hits)
                {
                    return [.. _hits];
                }
            }
        }

        public void Clear()
        {
            lock (_hits)
            {
                _hits.Clear();
                _run++;
            }
        }

        public void Dispose()
        {
            _stop.Cancel();
            _tcp.Stop();
            _udp.Dispose();
            _stop.Dispose();
        }

        /// <summary>Only into the run it arrived in, as a connection with no bytes takes a second to be sure of.</summary>
        private void Add(int run, string hit)
        {
            lock (_hits)
            {
                if (run == _run)
                {
                    _hits.Add(hit);
                }
            }
        }

        private int CurrentRun()
        {
            lock (_hits)
            {
                return _run;
            }
        }

        private async Task AcceptAsync()
        {
            try
            {
                while (true)
                {
                    _ = ServeAsync(await _tcp.AcceptTcpClientAsync(_stop.Token));
                }
            }
            catch (Exception failure) when (failure is OperationCanceledException or SocketException or ObjectDisposedException)
            {
                // Stopping is how this ends.
            }
        }

        private async Task ServeAsync(TcpClient client)
        {
            var run = CurrentRun();
            using (client)
            {
                try
                {
                    var stream = client.GetStream();
                    var buffer = new byte[4096];
                    using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                    var read = 0;
                    try
                    {
                        read = await stream.ReadAsync(buffer, wait.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        // A connection and no bytes is what a preconnect is.
                    }

                    var line = Encoding.Latin1.GetString(buffer, 0, read).Split("\r\n")[0];
                    Add(run, read == 0 ? "tcp (no bytes)" : $"tcp {line.Split('?')[0]}");
                    await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nok"u8.ToArray());
                }
                catch (IOException failure)
                {
                    Trace.WriteLine(failure.Message);
                }
            }
        }

        private async Task ReceiveAsync()
        {
            try
            {
                while (true)
                {
                    var datagram = await _udp.ReceiveAsync(_stop.Token);
                    Add(CurrentRun(), $"udp {datagram.Buffer.Length} bytes");
                }
            }
            catch (Exception failure) when (failure is OperationCanceledException or SocketException or ObjectDisposedException)
            {
                // Stopping is how this ends.
            }
        }
    }
}
