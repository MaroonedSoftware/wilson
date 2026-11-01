using System.Net;
using System.Security.Authentication;
using MaroonedSoftware.Wilson.Desktop.Core.Net;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Net;

public class ServerProbeTests
{
    private const string Origin = "http://tower:13101";

    [Fact]
    public async Task AsksHealthAndKnowsWilson()
    {
        using var server = new FakeServer((_, _) => FakeServer.Json(HttpStatusCode.OK, """{"ok":true,"project":"wilson","head":"abc","added":"later"}"""));

        Assert.Equal(ServerProbeResult.Wilson, await ServerProbe.AskAsync(Origin, server, TestContext.Current.CancellationToken));
        Assert.Equal("/api/health", Assert.Single(server.Requests).Path);
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound, "{}")]
    [InlineData(HttpStatusCode.OK, "<html>a router</html>")]
    [InlineData(HttpStatusCode.OK, """{"ok":true}""")]
    [InlineData(HttpStatusCode.OK, "[]")]
    public async Task SomethingElseIsNotWilson(HttpStatusCode status, string body)
    {
        using var server = new FakeServer((_, _) => FakeServer.Json(status, body));

        Assert.Equal(ServerProbeResult.NotWilson, await ServerProbe.AskAsync(Origin, server, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task NoAnswerIsUnreachable()
    {
        using var server = new FakeServer((_, _) => throw new HttpRequestException("refused"));

        Assert.Equal(ServerProbeResult.Unreachable, await ServerProbe.AskAsync(Origin, server, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task ACertificateIsToldApart()
    {
        using var server = new FakeServer((_, _) => throw new HttpRequestException("tls", new AuthenticationException("untrusted")));

        Assert.Equal(ServerProbeResult.Untrusted, await ServerProbe.AskAsync(Origin, server, TestContext.Current.CancellationToken));
    }
}
