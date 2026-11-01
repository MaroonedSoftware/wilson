using System.Security.Authentication;
using System.Text.Json;

namespace MaroonedSoftware.Wilson.Desktop.Core.Net;

/// <summary>What was found at an address. Each case is a different thing for the person to do next.</summary>
public enum ServerProbeResult
{
    Wilson,

    /// <summary>Something answered and it was not Wilson.</summary>
    NotWilson,

    /// <summary>Nothing answered.</summary>
    Unreachable,

    /// <summary>Something answered, but this Mac does not trust its certificate.</summary>
    Untrusted,
}

/// <summary>Asking an address whether Wilson is there, before anything is kept or typed at it.</summary>
/// <remarks>
/// `GET /api/health` is the question the Android app asks, and it needs no session. It is read loosely
/// rather than through the SDK, whose decoding would call a newer server something other than Wilson.
/// </remarks>
public static class ServerProbe
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    /// <param name="origin">A bare origin from <see cref="ServerAddress.Parse"/>.</param>
    /// <param name="transport">The bottom of the handler stack, which a test replaces.</param>
    /// <param name="cancellationToken">Stops asking.</param>
    public static async Task<ServerProbeResult> AskAsync(string origin, HttpMessageHandler? transport = null, CancellationToken cancellationToken = default)
    {
        using var http = new HttpClient(transport ?? new HttpClientHandler(), disposeHandler: transport is null) { Timeout = Timeout.InfiniteTimeSpan };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(Patience);

        try
        {
            using var response = await http.GetAsync(new Uri($"{origin}/api/health"), timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return ServerProbeResult.NotWilson;
            }

            var body = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            return IsHealth(body) ? ServerProbeResult.Wilson : ServerProbeResult.NotWilson;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (HttpRequestException failure) when (failure.InnerException is AuthenticationException)
        {
            return ServerProbeResult.Untrusted;
        }
        catch (Exception failure) when (failure is HttpRequestException or IOException or OperationCanceledException)
        {
            return ServerProbeResult.Unreachable;
        }
    }

    private static bool IsHealth(string body)
    {
        try
        {
            using var health = JsonDocument.Parse(body);
            return health.RootElement.ValueKind == JsonValueKind.Object
                && health.RootElement.TryGetProperty("ok", out var ok) && ok.ValueKind is JsonValueKind.True or JsonValueKind.False
                && health.RootElement.TryGetProperty("project", out var project) && project.ValueKind == JsonValueKind.String;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
