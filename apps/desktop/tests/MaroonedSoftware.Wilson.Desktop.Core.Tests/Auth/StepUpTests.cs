using System.Net;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Auth;

public sealed class StepUpTests
{
    private const string Origin = "https://wilson.test";
    private const string Asks = """{"message":"Forbidden","details":{"kind":"step_up_required","within":300}}""";

    /// <summary>Refuses factors until the token has been replaced, as the policy does for an old session.</summary>
    private static FakeServer Server() => new((request, _) => request.RequestUri!.AbsolutePath switch
    {
        "/api/auth/token" => FakeServer.Json(HttpStatusCode.OK, FakeServer.Token("fresh", "r2")),
        _ when request.Headers.Authorization?.Parameter == "fresh" => FakeServer.Json(HttpStatusCode.OK, "[]"),
        _ => FakeServer.Json(HttpStatusCode.Forbidden, Asks),
    });

    private static async Task<ServerConnection> SignedIn(FakeServer server, InMemorySecretStore store)
    {
        await store.WriteAsync(new StoredSession { Origin = Origin, Email = "a@b.c", AccessToken = "old", RefreshToken = "r1" });
        var connection = new ServerConnection(Origin, store, server);
        await connection.Session.RestoreAsync();
        return connection;
    }

    [Fact]
    public async Task A_confirmed_step_up_replays_the_request_with_the_new_session()
    {
        using var server = Server();
        using var connection = await SignedIn(server, new InMemorySecretStore());
        var asked = 0;
        connection.Session.StepUp = async token =>
        {
            asked++;
            await connection.Session.SignInAsync("a@b.c", "again", token);
            return true;
        };

        var factors = await connection.Sdk.Factors.ListSecondFactorsAsync(TestContext.Current.CancellationToken);

        Assert.Empty(factors);
        Assert.Equal(1, asked);
        Assert.Equal("fresh", server.Requests[^1].Bearer);
    }

    [Fact]
    public async Task Cancelling_leaves_the_request_refused_and_readable()
    {
        using var server = Server();
        using var connection = await SignedIn(server, new InMemorySecretStore());
        connection.Session.StepUp = _ => Task.FromResult(false);

        var failure = await Assert.ThrowsAsync<SdkException>(() => connection.Sdk.Factors.ListSecondFactorsAsync(TestContext.Current.CancellationToken));

        Assert.True(ApiError.IsStepUpRequired(failure));
        Assert.Equal("This change needs you to sign in again.", ApiError.Reason(failure));
        Assert.Single(server.Requests);
    }

    [Fact]
    public async Task A_body_goes_again_on_the_replay()
    {
        using var server = Server();
        using var connection = await SignedIn(server, new InMemorySecretStore());
        connection.Session.StepUp = async token =>
        {
            await connection.Session.SignInAsync("a@b.c", "again", token);
            return true;
        };

        await connection.Sdk.Hosts.RegisterHostAsync(new CreateHostRequest { Name = "kept" }, TestContext.Current.CancellationToken).ContinueWith(_ => { }, TestContext.Current.CancellationToken);

        Assert.Contains("kept", server.Requests[^1].Body, StringComparison.Ordinal);
        Assert.Equal("fresh", server.Requests[^1].Bearer);
    }

    [Fact]
    public async Task Any_other_403_asks_nothing()
    {
        using var server = new FakeServer((_, _) => FakeServer.Json(HttpStatusCode.Forbidden, """{"details":{"reason":"no"}}"""));
        using var connection = await SignedIn(server, new InMemorySecretStore());
        var asked = false;
        connection.Session.StepUp = _ =>
        {
            asked = true;
            return Task.FromResult(true);
        };

        var failure = await Assert.ThrowsAsync<SdkException>(() => connection.Sdk.Factors.ListSecondFactorsAsync(TestContext.Current.CancellationToken));

        Assert.False(asked);
        Assert.Equal("no", ApiError.Reason(failure));
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("not json", false)]
    [InlineData("[]", false)]
    [InlineData("""{"details":{"kind":"step_up_unavailable"}}""", false)]
    [InlineData(Asks, true)]
    public void The_body_is_what_asks(string? body, bool expected) =>
        Assert.Equal(expected, ApiError.IsStepUpRequired(body));
}
