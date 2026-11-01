using System.Net;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Net;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Net;

public class FollowTests
{
    private const string Origin = "http://tower:13101";

    private static readonly StoredSession Held = new() { Origin = Origin, Email = "a@b.c", AccessToken = "at", RefreshToken = "rt" };

    [Fact]
    public async Task ReportsLiveThenEventsThenTheDrop_AndResumesFromTheLastId()
    {
        var cancel = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var server = new FakeServer((_, _) => FakeServer.Json(HttpStatusCode.OK, "id: 4\nevent: turn\ndata: hi\n\n"));
        var store = new InMemorySecretStore();
        await store.WriteAsync(Held, TestContext.Current.CancellationToken);
        using var connection = new ServerConnection(Origin, store, server);
        await connection.Session.RestoreAsync(TestContext.Current.CancellationToken);
        List<StreamSignal> signals = [];

        await connection.FollowAsync(
            "/api/feed",
            "wilson",
            signal =>
            {
                signals.Add(signal);
                if (signals.Count == 3)
                {
                    cancel.Cancel();
                }

                return Task.CompletedTask;
            },
            cancellationToken: cancel.Token);

        Assert.IsType<StreamSignal.Live>(signals[0]);
        Assert.Equal("hi", Assert.IsType<StreamSignal.Received>(signals[1]).Event.Data);
        Assert.IsType<StreamSignal.Down>(signals[2]);
        Assert.Equal("at", server.Requests[0].Bearer);
    }

    [Fact]
    public async Task EndsWhenThereIsNoSession()
    {
        var server = new FakeServer((_, _) => FakeServer.Json(HttpStatusCode.OK, string.Empty));
        using var connection = new ServerConnection(Origin, new InMemorySecretStore(), server);

        await connection.FollowAsync("/api/feed", null, _ => Task.CompletedTask, cancellationToken: TestContext.Current.CancellationToken);

        Assert.Empty(server.Requests);
    }
}
