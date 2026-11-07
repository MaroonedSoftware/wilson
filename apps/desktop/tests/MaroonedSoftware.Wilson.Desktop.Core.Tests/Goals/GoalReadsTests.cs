using System.Net;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Goals;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Sdk.Models;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Goals;

public sealed class GoalReadsTests
{
    private const string Origin = "http://wilson.test";

    private const string TwoGoals = """
        [{"id":"1","threadId":"10","project":"wilson","title":"Older","outcome":"a","status":"done","createdAt":"2026-11-05T10:00:00Z","updatedAt":"2026-11-05T10:00:00Z"},
         {"id":"2","threadId":"11","project":"other","title":"Newer","outcome":"b","status":"active","createdAt":"2026-11-05T10:00:00Z","updatedAt":"2026-11-06T10:00:00Z"}]
        """;

    /// <summary>A connection whose server answers every request the same, noting each path and any project header in `seen`.</summary>
    private static ServerConnection Serve(HttpStatusCode status, string body, List<(string Url, string? Project)> seen) =>
        new(Origin, new InMemorySecretStore(), new FakeServer((request, _) =>
        {
            seen.Add((request.RequestUri!.PathAndQuery, request.Headers.TryGetValues("X-Wilson-Project", out var project) ? project.Single() : null));
            return FakeServer.Json(status, body);
        }));

    [Fact]
    public async Task Lists_every_goal_with_no_project_newest_first()
    {
        var seen = new List<(string Url, string? Project)>();
        using var connection = Serve(HttpStatusCode.OK, TwoGoals, seen);

        var goals = await new GoalReads(connection.Sdk).ListAsync(cancellationToken: TestContext.Current.CancellationToken);

        Assert.Equal(["2", "1"], goals.Select(goal => goal.Id));
        var request = Assert.Single(seen);
        Assert.Equal("/api/goals", request.Url);
        Assert.Null(request.Project);
    }

    [Fact]
    public async Task Filters_by_status_and_thread_as_the_server_spells_them()
    {
        var seen = new List<(string Url, string? Project)>();
        using var connection = Serve(HttpStatusCode.OK, "[]", seen);
        var reads = new GoalReads(connection.Sdk);

        Assert.Empty(await reads.ListAsync(GoalStatus.Paused, cancellationToken: TestContext.Current.CancellationToken));
        await reads.ListAsync(threadId: "42", cancellationToken: TestContext.Current.CancellationToken);
        await reads.ListAsync(GoalStatus.Abandoned, "42", TestContext.Current.CancellationToken);

        Assert.Equal(["/api/goals?status=paused", "/api/goals?threadId=42", "/api/goals?status=abandoned&threadId=42"], seen.Select(request => request.Url));
    }

    [Fact]
    public async Task An_unknown_status_is_not_sent()
    {
        var seen = new List<(string Url, string? Project)>();
        using var connection = Serve(HttpStatusCode.OK, "[]", seen);

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => new GoalReads(connection.Sdk).ListAsync(GoalStatus.Unknown, cancellationToken: TestContext.Current.CancellationToken));
        Assert.Empty(seen);
    }

    [Fact]
    public async Task A_refusal_carries_the_server_s_reason()
    {
        using var connection = Serve(HttpStatusCode.Forbidden, """{"message":"Forbidden","details":{"reason":"This key may not read goals."}}""", []);

        var failure = await Assert.ThrowsAnyAsync<HttpRequestException>(() => new GoalReads(connection.Sdk).ListAsync(cancellationToken: TestContext.Current.CancellationToken));

        Assert.Equal("This key may not read goals.", ApiError.Reason(failure));
    }
}
