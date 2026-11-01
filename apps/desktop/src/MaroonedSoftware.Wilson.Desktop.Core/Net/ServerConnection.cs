using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Sdk;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Net;

/// <summary>One server: its origin, the SDK pointed at it, and the session held with it.</summary>
/// <remarks>
/// The handler needs the session and the session needs the SDK that sits on the handler, so the
/// handler is given a function and this is where the loop is tied.
/// </remarks>
public sealed class ServerConnection : IDisposable
{
    private const string ProjectHeader = "X-Wilson-Project";

    private readonly HttpClient _http;

    /// <param name="origin">A bare origin from <see cref="ServerAddress.Parse"/>.</param>
    /// <param name="store">Where the session is kept.</param>
    /// <param name="transport">The bottom of the handler stack, which a test replaces.</param>
    public ServerConnection(string origin, ISecretStore store, HttpMessageHandler? transport = null)
    {
        Origin = origin;
        var handler = new SessionHandler(() => Session) { InnerHandler = transport ?? new HttpClientHandler() };

        // No overall timeout: a merge runs the suite before answering, and event streams never end.
        _http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        Sdk = new WilsonSdk(new SdkOptions { BaseUrl = origin, HttpClient = _http });
        Session = new SessionManager(origin, Sdk, store);
    }

    public string Origin { get; }

    public WilsonSdk Sdk { get; }

    public SessionManager Session { get; }

    /// <summary>A client scoped to one project. Its `X-Wilson-Project` is fixed, so a change of project builds another.</summary>
    public WilsonSdk ForProject(string project) =>
        new(new SdkOptions
        {
            BaseUrl = Origin,
            HttpClient = _http,
            Headers = _ => new ValueTask<IReadOnlyDictionary<string, string>>(new Dictionary<string, string> { [ProjectHeader] = project }),
        });

    /// <summary>
    /// Holds an event stream open until cancelled, reconnecting after any drop and resuming from the
    /// last id seen. These routes are not in the contracts, so the SDK has no method for them. A 401
    /// goes through <see cref="SessionHandler"/> like any other call, and the loop ends when the
    /// session does, because nothing else makes reconnecting pointless.
    /// </summary>
    public async Task FollowAsync(string path, string? project, Func<StreamSignal, Task> receive, string? resumeFrom = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(receive);

        var lastId = resumeFrom;
        var attempt = 0;

        try
        {
            while (Session.IsSignedIn)
            {
                try
                {
                    using var request = new HttpRequestMessage(HttpMethod.Get, new Uri($"{Origin}{path}"));
                    request.Headers.Accept.ParseAdd("text/event-stream");
                    if (project is not null)
                    {
                        request.Headers.TryAddWithoutValidation(ProjectHeader, project);
                    }

                    if (lastId is not null)
                    {
                        request.Headers.TryAddWithoutValidation("Last-Event-ID", lastId);
                    }

                    using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
                    response.EnsureSuccessStatusCode();

                    attempt = 0;
                    await receive(new StreamSignal.Live()).ConfigureAwait(false);

                    using var lines = new StreamReader(await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false));
                    var reader = new SseReader();
                    while (await lines.ReadLineAsync(cancellationToken).ConfigureAwait(false) is { } line)
                    {
                        if (reader.Line(line) is { } received)
                        {
                            lastId = received.Id ?? lastId;
                            await receive(new StreamSignal.Received(received)).ConfigureAwait(false);
                        }
                    }
                }
                catch (Exception failure) when (failure is HttpRequestException or IOException)
                {
                    // Any drop is the same to a stream: say so and go round again.
                }

                await receive(new StreamSignal.Down()).ConfigureAwait(false);
                await Task.Delay(StreamSignal.ReconnectDelay(attempt++), cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Leaving the screen is how a stream ends.
        }
    }

    public void Dispose()
    {
        Session.Dispose();
        Sdk.Dispose();
        _http.Dispose();
    }
}
