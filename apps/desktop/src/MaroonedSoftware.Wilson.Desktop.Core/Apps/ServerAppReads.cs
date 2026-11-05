using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Apps;

/// <summary>
/// The five reads, against one project, keeping the API's own JSON. The generated clients decode into
/// models, which is what <see cref="AppBroker"/> must not hand on (it says why), so this goes one layer
/// under them, to the same routes through the same session.
/// </summary>
public sealed class ServerAppReads(SdkHttp http) : IAppReads
{
    public Task<string> ListCardsAsync(CancellationToken cancellationToken) => GetAsync(http.Path("api", "cards"), null, cancellationToken);

    public Task<string> GetCardAsync(string id, CancellationToken cancellationToken) => GetAsync(http.Path("api", "cards", http.Segment(id)), null, cancellationToken);

    public Task<string> ListBoardColumnsAsync(CancellationToken cancellationToken) => GetAsync(http.Path("api", "stages"), null, cancellationToken);

    public Task<string> ListProjectActivityAsync(long? limit, long? before, CancellationToken cancellationToken) =>
        GetAsync(http.Path("api", "activity"), http.Params(new ActivityQuery { Limit = limit, Before = before }), cancellationToken);

    public Task<string> GetProjectStatsAsync(long? days, CancellationToken cancellationToken) =>
        GetAsync(http.Path("api", "stats"), http.Params(new ProjectStatsQuery { Days = days }), cancellationToken);

    private async Task<string> GetAsync(string path, IEnumerable<KeyValuePair<string, string>>? query, CancellationToken cancellationToken)
    {
        var response = await http.ExecuteAsync(HttpMethod.Get, path, query, cancellationToken: cancellationToken).ConfigureAwait(false);
        return response.Text;
    }
}
