using System.Net;
using System.Net.Http.Headers;

namespace MaroonedSoftware.Wilson.Desktop.Core.Auth;

/// <summary>Attaches the bearer, and turns one rejected token into one retry.</summary>
/// <remarks>
/// On the shared client rather than in the SDK, so anything added later goes through the same
/// refresh. The token endpoint is exempt: a 401 from it is a wrong password or the session ending,
/// and refreshing in response would be a loop.
/// </remarks>
public sealed class SessionHandler(Func<SessionManager?> session) : DelegatingHandler
{
    private const string TokenPath = "/api/auth/token";

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var manager = session();
        if (manager is null || request.RequestUri?.AbsolutePath == TokenPath)
        {
            return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }

        var token = manager.AccessToken;
        if (token is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        // Before sending: a replay needs the body again, and a stream read once cannot give it.
        if (request.Content is not null)
        {
            await request.Content.LoadIntoBufferAsync(cancellationToken).ConfigureAwait(false);
        }

        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (response.StatusCode != HttpStatusCode.Unauthorized || token is null)
        {
            return response;
        }

        // Ended or unavailable, the caller's own 401 is the true answer to what it asked.
        if (await manager.RefreshedAsync(token, cancellationToken).ConfigureAwait(false) is not RefreshOutcome.Renewed renewed)
        {
            return response;
        }

        response.Dispose();

        // Once. A second 401 after a fresh token is not a token problem.
        using var replay = Clone(request, renewed.AccessToken);
        return await base.SendAsync(replay, cancellationToken).ConfigureAwait(false);
    }

    private static HttpRequestMessage Clone(HttpRequestMessage request, string token)
    {
        var replay = new HttpRequestMessage(request.Method, request.RequestUri)
        {
            Version = request.Version,
            VersionPolicy = request.VersionPolicy,
            Content = request.Content,
        };

        foreach (var header in request.Headers)
        {
            replay.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        replay.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return replay;
    }
}
