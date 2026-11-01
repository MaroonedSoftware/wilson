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

    public void Dispose()
    {
        Session.Dispose();
        Sdk.Dispose();
        _http.Dispose();
    }
}
