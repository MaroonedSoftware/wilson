using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Apps;

/// <summary>
/// The five reads, against one project, from version 1 of the app API (`app.api.ck`), keeping the API's own JSON. The generated clients decode into
/// models, which is what <see cref="AppBroker"/> must not hand on (it says why), so this goes one layer
/// under them, to the same routes through the same session.
/// </summary>
public sealed class ServerAppReads(SdkHttp http) : IAppReads
{
    public Task<string> ListCardsAsync(CancellationToken cancellationToken) => GetAsync(http.Path("api", "app-api", "v1", "cards"), null, cancellationToken);

    public Task<string> GetCardAsync(string id, CancellationToken cancellationToken) => GetAsync(http.Path("api", "app-api", "v1", "cards", http.Segment(id)), null, cancellationToken);

    public Task<string> ListBoardColumnsAsync(CancellationToken cancellationToken) => GetAsync(http.Path("api", "app-api", "v1", "columns"), null, cancellationToken);

    public Task<string> ListProjectActivityAsync(long? limit, long? before, CancellationToken cancellationToken) =>
        GetAsync(http.Path("api", "app-api", "v1", "activity"), http.Params(new AppV1ActivityQuery { Limit = limit, Before = before }), cancellationToken);

    public Task<string> GetProjectStatsAsync(long? days, CancellationToken cancellationToken) =>
        GetAsync(http.Path("api", "app-api", "v1", "stats"), http.Params(new AppV1StatsQuery { Days = days }), cancellationToken);

    private async Task<string> GetAsync(string path, IEnumerable<KeyValuePair<string, string>>? query, CancellationToken cancellationToken)
    {
        var response = await http.ExecuteAsync(HttpMethod.Get, path, query, cancellationToken: cancellationToken).ConfigureAwait(false);
        return response.Text;
    }
}
