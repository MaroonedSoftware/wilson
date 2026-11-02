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
        if (response.StatusCode == HttpStatusCode.Unauthorized && token is not null)
        {
            // Ended or unavailable, the caller's own 401 is the true answer to what it asked.
            if (await manager.RefreshedAsync(token, cancellationToken).ConfigureAwait(false) is not RefreshOutcome.Renewed renewed)
            {
                return response;
            }

            // Once. A second 401 after a fresh token is not a token problem.
            response.Dispose();
            response = await ReplayAsync(request, renewed.AccessToken, cancellationToken).ConfigureAwait(false);
        }

        if (response.StatusCode == HttpStatusCode.Forbidden
            && manager.StepUp is { } stepUp
            && ApiError.IsStepUpRequired(await BodyAsync(response, cancellationToken).ConfigureAwait(false))
            && await stepUp(cancellationToken).ConfigureAwait(false)
            && manager.AccessToken is { } fresh)
        {
            response.Dispose();
            response = await ReplayAsync(request, fresh, cancellationToken).ConfigureAwait(false);
        }

        return response;
    }

    /// <summary>Buffered, so whoever receives the response can still read it.</summary>
    private static async Task<string> BodyAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        await response.Content.LoadIntoBufferAsync(cancellationToken).ConfigureAwait(false);
        return await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<HttpResponseMessage> ReplayAsync(HttpRequestMessage request, string token, CancellationToken cancellationToken)
    {
        using var replay = Clone(request, token);
        try
        {
            return await base.SendAsync(replay, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            // Shared with the request, which may yet be replayed again.
            replay.Content = null;
        }
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
