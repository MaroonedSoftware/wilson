using System.Diagnostics;
using System.Text.Json;

namespace MaroonedSoftware.Wilson.Desktop.Core.Updates;

/// <summary>Asks GitHub whether there is a newer desktop release.</summary>
/// <remarks>
/// Handed its own <see cref="HttpClient"/>, never the server's, which carries the operator's bearer
/// token on every request. Every failure answers nothing and writes a line to the log: an update is
/// a convenience, and a GitHub that is down must never be something the app reports.
/// </remarks>
public sealed class UpdateChecker(HttpClient http, Version current)
{
    public async Task<UpdateAvailable?> CheckAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, UpdateCheck.Endpoint);
            request.Headers.Accept.ParseAdd("application/vnd.github+json");
            using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                Trace.WriteLine($"updates: GitHub answered {(int)response.StatusCode}");
                return null;
            }

            return UpdateCheck.Newest(current, await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
        }
        catch (Exception failure) when (failure is HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException or InvalidOperationException)
        {
            Trace.WriteLine($"updates: could not ask GitHub: {failure.Message}");
            return null;
        }
    }
}
