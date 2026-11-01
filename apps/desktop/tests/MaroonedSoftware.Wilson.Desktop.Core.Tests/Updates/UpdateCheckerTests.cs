using System.Net;
using MaroonedSoftware.Wilson.Desktop.Core.Updates;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Updates;

public class UpdateCheckerTests
{
    private const string Newer = """[{"tag_name":"desktop-v0.3.0","draft":false,"prerelease":false,"html_url":"https://example.com/r","assets":[]}]""";

    private static UpdateChecker Answering(Func<HttpResponseMessage> answer) =>
        new(new HttpClient(new FakeServer((_, _) => answer())), new Version(0, 2, 0));

    [Fact]
    public async Task ANewerRelease_IsFound()
    {
        var result = await Answering(() => FakeServer.Json(HttpStatusCode.OK, Newer)).CheckAsync(TestContext.Current.CancellationToken);

        Assert.True(result.Answered);
        Assert.Equal(new Version(0, 3, 0), result.Found?.Version);
    }

    [Fact]
    public async Task NothingNewer_IsStillAnAnswer()
    {
        var result = await Answering(() => FakeServer.Json(HttpStatusCode.OK, "[]")).CheckAsync(TestContext.Current.CancellationToken);

        Assert.True(result.Answered);
        Assert.Null(result.Found);
    }

    [Fact]
    public async Task ARefusal_IsNotAnAnswer()
    {
        var result = await Answering(() => FakeServer.Json(HttpStatusCode.Forbidden, "{}")).CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.Answered);
    }

    [Fact]
    public async Task NoNetwork_IsNotAnAnswer()
    {
        var result = await Answering(() => throw new HttpRequestException("down")).CheckAsync(TestContext.Current.CancellationToken);

        Assert.False(result.Answered);
    }
}
