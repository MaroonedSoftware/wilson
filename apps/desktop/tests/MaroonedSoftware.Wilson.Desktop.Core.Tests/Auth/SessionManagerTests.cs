using System.Net;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Net;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Auth;

public class SessionManagerTests
{
    private const string Origin = "http://tower:13101";
    private const string TokenPath = "/api/auth/token";
    private const string Refused = "Bearer error=\"invalid_grant\"";

    private static readonly StoredSession Held = new() { Origin = Origin, Email = "operator@example.com", AccessToken = "old", RefreshToken = "r1" };

    private static async Task<(ServerConnection Connection, InMemorySecretStore Store)> SignedIn(FakeServer server)
    {
        var store = new InMemorySecretStore();
        await store.WriteAsync(Held, TestContext.Current.CancellationToken);
        var connection = new ServerConnection(Origin, store, server);
        await connection.Session.RestoreAsync(TestContext.Current.CancellationToken);
        return (connection, store);
    }

    private static FakeServer ProjectsAnswering(string goodToken, Func<HttpResponseMessage> refresh) =>
        new((request, _) => request.RequestUri!.AbsolutePath == TokenPath
            ? refresh()
            : request.Headers.Authorization?.Parameter == goodToken
                ? FakeServer.Json(HttpStatusCode.OK, "[]")
                : FakeServer.Json(HttpStatusCode.Unauthorized, "{}", "Bearer error=\"invalid_token\""));

    [Fact]
    public async Task APasswordSignsInAndIsRemembered()
    {
        var server = new FakeServer((_, _) => FakeServer.Json(HttpStatusCode.OK, FakeServer.Token("a", "r")));
        var store = new InMemorySecretStore();
        using var connection = new ServerConnection(Origin, store, server);

        var result = await connection.Session.SignInAsync("operator@example.com", "pw", TestContext.Current.CancellationToken);

        Assert.IsType<SignInResult.SignedIn>(result);
        Assert.Equal("a", (await store.ReadAsync(Origin, TestContext.Current.CancellationToken))?.AccessToken);
        Assert.Contains("\"grant_type\":\"password\"", server.Requests[0].Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ASecondFactorPicksTheAuthenticator_NotWhicheverWasEnrolledFirst()
    {
        const string Challenge = """
            {"result":"mfa_required","challengeId":"c1","factors":[{"method":"passkey","id":"p1"},{"method":"authenticator","id":"f1","label":"Phone"}]}
            """;
        var server = new FakeServer((_, body) => body!.Contains("\"password\"", StringComparison.Ordinal)
            ? FakeServer.Json(HttpStatusCode.OK, Challenge)
            : FakeServer.Json(HttpStatusCode.OK, FakeServer.Token("a", "r")));
        using var connection = new ServerConnection(Origin, new InMemorySecretStore(), server);

        var result = await connection.Session.SignInAsync("operator@example.com", "pw", TestContext.Current.CancellationToken);
        var pending = Assert.IsType<SignInResult.CodeNeeded>(result);
        Assert.Equal("f1", pending.FactorId);

        await connection.Session.CompleteSignInAsync(pending, "123456", TestContext.Current.CancellationToken);

        Assert.Equal("operator@example.com", connection.Session.Email);
        Assert.Contains("\"factor_id\":\"f1\"", server.Requests[1].Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APasskeyAloneIsSaidRatherThanAskedForACode()
    {
        var server = new FakeServer((_, _) => FakeServer.Json(HttpStatusCode.OK, """{"result":"mfa_required","challengeId":"c1","factors":[{"method":"passkey","id":"p1"}]}"""));
        using var connection = new ServerConnection(Origin, new InMemorySecretStore(), server);

        Assert.IsType<SignInResult.PasskeyOnly>(await connection.Session.SignInAsync("a@b.c", "pw", TestContext.Current.CancellationToken));
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, typeof(SignInResult.Refused))]
    [InlineData((HttpStatusCode)429, typeof(SignInResult.TooManyAttempts))]
    [InlineData(HttpStatusCode.BadGateway, typeof(SignInResult.Unavailable))]
    public async Task SignInFailuresStayDistinct(HttpStatusCode status, Type expected)
    {
        var server = new FakeServer((_, _) => FakeServer.Json(status, "{}"));
        using var connection = new ServerConnection(Origin, new InMemorySecretStore(), server);

        Assert.IsType(expected, await connection.Session.SignInAsync("a@b.c", "pw", TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task ARejectedTokenRefreshesAndReplaysOnce()
    {
        var server = ProjectsAnswering("new", () => FakeServer.Json(HttpStatusCode.OK, FakeServer.Token("new", "r2")));
        var (connection, store) = await SignedIn(server);
        using (connection)
        {
            Assert.Empty(await connection.Sdk.Projects.ListProjectsAsync(TestContext.Current.CancellationToken));

            Assert.Equal(["/api/projects", TokenPath, "/api/projects"], server.Requests.Select(request => request.Path));
            Assert.Equal("r2", (await store.ReadAsync(Origin, TestContext.Current.CancellationToken))?.RefreshToken);
        }
    }

    [Fact]
    public async Task ConcurrentRejectionsShareOneRefresh_BecauseASecondWouldRevokeTheFamily()
    {
        var server = ProjectsAnswering("new", () => FakeServer.Json(HttpStatusCode.OK, FakeServer.Token("new", "r2")));
        var (connection, _) = await SignedIn(server);
        using (connection)
        {
            var outcomes = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => connection.Session.RefreshedAsync("old", TestContext.Current.CancellationToken)));

            Assert.All(outcomes, outcome => Assert.Equal("new", Assert.IsType<RefreshOutcome.Renewed>(outcome).AccessToken));
            Assert.Single(server.Requests, request => request.Path == TokenPath);
        }
    }

    [Fact]
    public async Task TheApiRefusingTheRefreshEndsTheSession()
    {
        var server = ProjectsAnswering("new", () => FakeServer.Json(HttpStatusCode.Unauthorized, "{}", Refused));
        var (connection, store) = await SignedIn(server);
        using (connection)
        {
            var ended = false;
            connection.Session.SessionEnded += (_, _) => ended = true;

            var outcome = await connection.Session.RefreshedAsync("old", TestContext.Current.CancellationToken);

            Assert.IsType<RefreshOutcome.SessionEnded>(outcome);
            Assert.True(ended);
            Assert.False(connection.Session.IsSignedIn);
            Assert.Null(await store.ReadAsync(Origin, TestContext.Current.CancellationToken));
        }
    }

    [Theory]
    [InlineData(HttpStatusCode.ServiceUnavailable, null)]
    [InlineData((HttpStatusCode)429, null)]
    [InlineData(HttpStatusCode.Unauthorized, "Basic realm=\"proxy\"")]
    [InlineData(HttpStatusCode.Forbidden, null)]
    public async Task AnythingElseKeepsTheSession(HttpStatusCode status, string? challenge)
    {
        var server = ProjectsAnswering("new", () => FakeServer.Json(status, "{}", challenge));
        var (connection, store) = await SignedIn(server);
        using (connection)
        {
            var failure = await Record.ExceptionAsync(() => connection.Session.RefreshedAsync("old", TestContext.Current.CancellationToken));

            Assert.Null(failure);
            Assert.True(connection.Session.IsSignedIn);
            Assert.NotNull(await store.ReadAsync(Origin, TestContext.Current.CancellationToken));
        }
    }

    [Fact]
    public async Task ARefreshThatCannotReachTheServerKeepsTheSession()
    {
        var server = new FakeServer((_, _) => throw new HttpRequestException("no route"));
        var (connection, _) = await SignedIn(server);
        using (connection)
        {
            Assert.IsType<RefreshOutcome.Unavailable>(await connection.Session.RefreshedAsync("old", TestContext.Current.CancellationToken));
            Assert.True(connection.Session.IsSignedIn);
        }
    }

    [Fact]
    public async Task SigningOutSendsTheTokenAndForgetsEvenIfTheServerIsGone()
    {
        var server = new FakeServer((_, _) => throw new HttpRequestException("no route"));
        var (connection, store) = await SignedIn(server);
        using (connection)
        {
            await connection.Session.SignOutAsync(TestContext.Current.CancellationToken);

            Assert.Equal("old", server.Requests[0].Bearer);
            Assert.False(connection.Session.IsSignedIn);
            Assert.Null(await store.ReadAsync(Origin, TestContext.Current.CancellationToken));
        }
    }
}
