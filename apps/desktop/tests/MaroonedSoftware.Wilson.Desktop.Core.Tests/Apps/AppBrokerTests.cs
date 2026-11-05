using System.Net;
using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Apps;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Apps;

/// <summary>What an app can get out of the host, which is `app.broker.test.ts` here. Everything it sends is hostile.</summary>
public class AppBrokerTests
{
    private static readonly AppGrant[] All = [AppGrant.BoardRead, AppGrant.ActivityRead, AppGrant.StatsRead];

    private sealed class FakeReads : IAppReads
    {
        public List<string> Calls { get; } = [];

        public TaskCompletionSource<string>? Hold { get; set; }

        public Exception? Failure { get; set; }

        public string Body { get; set; } = """[{"id":"0001"}]""";

        public Task<string> ListCardsAsync(CancellationToken cancellationToken) => Answer("listCards", cancellationToken);

        public Task<string> GetCardAsync(string id, CancellationToken cancellationToken) => Answer($"getCard:{id}", cancellationToken);

        public Task<string> ListBoardColumnsAsync(CancellationToken cancellationToken) => Answer("listBoardColumns", cancellationToken);

        public Task<string> ListProjectActivityAsync(long? limit, long? before, CancellationToken cancellationToken) => Answer($"activity:{limit}:{before}", cancellationToken);

        public Task<string> GetProjectStatsAsync(long? days, CancellationToken cancellationToken) => Answer($"stats:{days}", cancellationToken);

        private async Task<string> Answer(string call, CancellationToken cancellationToken)
        {
            Calls.Add(call);
            if (Failure is not null)
            {
                throw Failure;
            }

            return Hold is null ? Body : await Hold.Task.WaitAsync(cancellationToken);
        }
    }

    private static async Task<(JsonElement Answer, FakeReads Reads)> Ask(string method, string args = "[]", AppGrant[]? grants = null, FakeReads? reads = null)
    {
        reads ??= new FakeReads();
        var sent = new List<string>();
        using var broker = new AppBroker(grants ?? All, reads, sent.Add);

        await broker.ReceiveAsync($$"""{"id":7,"method":{{JsonSerializer.Serialize(method)}},"args":{{args}}}""");

        return (JsonDocument.Parse(Assert.Single(sent)).RootElement, reads);
    }

    private static async Task<string> Refusal(string method, string args = "[]", AppGrant[]? grants = null)
    {
        var (answer, reads) = await Ask(method, args, grants);

        Assert.False(answer.GetProperty("ok").GetBoolean());
        Assert.Equal(7, answer.GetProperty("id").GetInt32());
        Assert.Empty(reads.Calls);
        return answer.GetProperty("error").GetString()!;
    }

    public static TheoryData<string, string> EachMethod()
    {
        var methods = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "app-host.json"))).RootElement.GetProperty("methods");
        var data = new TheoryData<string, string>();
        // A method with no grant reads nothing, so it has none to need.
        foreach (var method in methods.EnumerateArray().Where(method => method.TryGetProperty("grant", out _)))
        {
            data.Add(method.GetProperty("name").GetString()!, method.GetProperty("grant").GetString()!);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(EachMethod))]
    public async Task AMethodNeedsItsGrantAndNothingElseWillDo(string method, string grant)
    {
        var args = method == "getCard" ? """["0001"]""" : "[]";
        var granted = JsonSerializer.Deserialize<AppGrant>($"\"{grant}\"", SdkJson.Options);

        Assert.True((await Ask(method, args, [granted])).Answer.GetProperty("ok").GetBoolean());
        Assert.Contains(grant, await Refusal(method, args, [.. All.Where(other => other != granted)]), StringComparison.Ordinal);
        Assert.Contains(grant, await Refusal(method, args, []), StringComparison.Ordinal);
    }

    [Fact]
    public async Task OpeningACardNeedsNoGrantAndAsksTheHost()
    {
        var opened = new List<string>();
        var sent = new List<string>();
        using var broker = new AppBroker([], new FakeReads(), sent.Add, opened.Add);

        await broker.ReceiveAsync("""{"id":7,"method":"openCard","args":["0001"]}""");

        Assert.Equal("""{"id":7,"ok":true,"result":null}""", Assert.Single(sent));
        Assert.Equal(["0001"], opened);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("""[".."]""")]
    [InlineData("""["0001","0002"]""")]
    [InlineData("[7]")]
    public async Task OpeningACardRefusesAnythingButOneId(string args)
    {
        var opened = new List<string>();
        var sent = new List<string>();
        using var broker = new AppBroker([], new FakeReads(), sent.Add, opened.Add);

        await broker.ReceiveAsync($$"""{"id":7,"method":"openCard","args":{{args}}}""");

        Assert.Contains("card id", Assert.Single(sent), StringComparison.Ordinal);
        Assert.Empty(opened);
    }

    [Fact]
    public void TheTableIsTheDocumentsList() => Assert.Equal(AppDocument.MethodNames, AppBroker.MethodNames);

    [Fact]
    public async Task AGrantThisBuildDoesNotKnowReachesNothing() =>
        Assert.Contains("board.read", await Refusal("listCards", grants: [AppGrant.Unknown]), StringComparison.Ordinal);

    [Theory]
    [InlineData("moveCard")]
    [InlineData("mergeCard")]
    [InlineData("createCard")]
    [InlineData("apiKeys")]
    [InlineData("constructor")]
    [InlineData("__proto__")]
    [InlineData("ListCards")]
    [InlineData("")]
    public async Task WhatIsNotOnTheListIsRefused(string method) =>
        Assert.Contains("no method", await Refusal(method), StringComparison.Ordinal);

    [Theory]
    [InlineData("""[".."]""")]
    [InlineData("""["."]""")]
    [InlineData("""["../auth/keys"]""")]
    [InlineData("""["0001/events"]""")]
    [InlineData("""["a?b=c"]""")]
    [InlineData("""["a#b"]""")]
    [InlineData("""["a b"]""")]
    [InlineData("""["0001\n"]""")]
    [InlineData("""[""]""")]
    [InlineData("""[1]""")]
    [InlineData("""[{}]""")]
    [InlineData("""[null]""")]
    [InlineData("""[]""")]
    [InlineData("""["0001","0002"]""")]
    public async Task WhatIsNotACardIdIsRefused(string args) =>
        Assert.Contains("card id", await Refusal("getCard", args), StringComparison.Ordinal);

    [Fact]
    public async Task ACardIdOfTheLongestAllowedLengthIsAskedFor()
    {
        var id = new string('x', 64);

        Assert.Equal($"getCard:{id}", Assert.Single((await Ask("getCard", $"[\"{id}\"]")).Reads.Calls));
        Assert.Contains("card id", await Refusal("getCard", $"[\"{id}x\"]"), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("listCards")]
    [InlineData("listBoardColumns")]
    public async Task AMethodWithNoArgumentsTakesNone(string method) =>
        Assert.Contains("no arguments", await Refusal(method, """[{"project":"other"}]"""), StringComparison.Ordinal);

    [Theory]
    [InlineData("""[{"limit":-1}]""", "whole number")]
    [InlineData("""[{"limit":1.5}]""", "whole number")]
    [InlineData("""[{"limit":"5"}]""", "whole number")]
    [InlineData("""[{"limit":9007199254740992}]""", "whole number")]
    [InlineData("""[{"project":"other"}]""", "unknown query field")]
    [InlineData("""[5]""", "query object")]
    [InlineData("""[[]]""", "query object")]
    [InlineData("""[{},{}]""", "at most one")]
    public async Task ABadQueryIsRefused(string args, string reason) =>
        Assert.Contains(reason, await Refusal("listProjectActivity", args), StringComparison.Ordinal);

    [Fact]
    public async Task AGoodQueryIsPassedOn()
    {
        Assert.Equal("activity:5:9", Assert.Single((await Ask("listProjectActivity", """[{"limit":5,"before":9}]""")).Reads.Calls));
        Assert.Equal("activity::", Assert.Single((await Ask("listProjectActivity", """[null]""")).Reads.Calls));
        Assert.Equal("stats:30", Assert.Single((await Ask("getProjectStats", """[{"days":30}]""")).Reads.Calls));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("""{"id":"1","method":"listCards","args":[]}""")]
    [InlineData("""{"id":1,"method":5,"args":[]}""")]
    [InlineData("""{"id":1,"method":"listCards"}""")]
    [InlineData("""{"id":1,"method":"listCards","args":{}}""")]
    public async Task WhatIsNotARequestGetsNoAnswer(string message)
    {
        var reads = new FakeReads();
        var sent = new List<string>();
        using var broker = new AppBroker(All, reads, sent.Add);

        await broker.ReceiveAsync(message);

        Assert.Empty(sent);
        Assert.Empty(reads.Calls);
    }

    [Fact]
    public async Task ARequestTooLongToBeOneIsNotRead()
    {
        var reads = new FakeReads();
        var sent = new List<string>();
        using var broker = new AppBroker(All, reads, sent.Add);

        await broker.ReceiveAsync($$"""{"id":1,"method":"listCards","args":[],"x":"{{new string('x', AppBroker.MaxRequestChars)}}"}""");

        Assert.Empty(sent);
    }

    [Fact]
    public async Task TheAnswerCarriesTheServersOwnJson()
    {
        var reads = new FakeReads { Body = """[{"id":"0001","createdAt":"2026-11-05T10:00:00.000Z","stage":"made-up"}]""" };

        var (answer, _) = await Ask("listCards", reads: reads);

        Assert.True(answer.GetProperty("ok").GetBoolean());
        Assert.Equal("made-up", answer.GetProperty("result")[0].GetProperty("stage").GetString());
        Assert.Equal("2026-11-05T10:00:00.000Z", answer.GetProperty("result")[0].GetProperty("createdAt").GetString());
    }

    [Theory]
    [InlineData("""1],"ok":true,"x":[2""")]
    [InlineData("<html>")]
    [InlineData("")]
    public async Task WhatIsNotOneJsonValueIsNotPassedOn(string body)
    {
        var (answer, _) = await Ask("listCards", reads: new FakeReads { Body = body });

        Assert.False(answer.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task AFailedCallGoesBackAsItsReason()
    {
        var reads = new FakeReads { Failure = new SdkException(404, """{"message":"no such card"}""") };

        var (answer, _) = await Ask("getCard", """["0001"]""", reads: reads);

        Assert.False(answer.GetProperty("ok").GetBoolean());
        Assert.Equal("no such card", answer.GetProperty("error").GetString());
    }

    [Fact]
    public async Task OnlySoManyMayWaitAndAFinishedOneMakesRoom()
    {
        var hold = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var reads = new FakeReads { Hold = hold };
        var sent = new List<string>();
        using var broker = new AppBroker(All, reads, answer =>
        {
            lock (sent)
            {
                sent.Add(answer);
            }
        });

        var waiting = Enumerable.Range(1, AppBroker.MaxRequestsInFlight).Select(id => broker.ReceiveAsync($$"""{"id":{{id}},"method":"listCards","args":[]}""")).ToList();
        await broker.ReceiveAsync("""{"id":99,"method":"listCards","args":[]}""");

        var refused = JsonDocument.Parse(Assert.Single(sent)).RootElement;
        Assert.Equal(99, refused.GetProperty("id").GetInt32());
        Assert.Contains("too many", refused.GetProperty("error").GetString(), StringComparison.Ordinal);
        Assert.Equal(AppBroker.MaxRequestsInFlight, reads.Calls.Count);

        hold.SetResult("[]");
        await Task.WhenAll(waiting);
        await broker.ReceiveAsync("""{"id":100,"method":"listCards","args":[]}""");

        Assert.Equal(AppBroker.MaxRequestsInFlight + 2, sent.Count);
    }

    [Fact]
    public async Task ClosingDropsWhatIsOnItsWayAndAnswersNothingMore()
    {
        var reads = new FakeReads { Hold = new TaskCompletionSource<string>() };
        var sent = new List<string>();
        var broker = new AppBroker(All, reads, sent.Add);
        var waiting = broker.ReceiveAsync("""{"id":1,"method":"listCards","args":[]}""");

        broker.Dispose();
        await waiting;
        await broker.ReceiveAsync("""{"id":2,"method":"listCards","args":[]}""");
        broker.Dispose();

        Assert.Empty(sent);
        Assert.Single(reads.Calls);
    }

    [Fact]
    public void TheGrantsNamesAreTheWire()
    {
        foreach (var grant in All)
        {
            Assert.Equal(JsonSerializer.Serialize(grant, SdkJson.Options), $"\"{AppDocument.GrantName(grant)}\"");
        }
    }

    [Fact]
    public async Task EveryReadIsAGetForTheOneProject()
    {
        var seen = new List<(HttpMethod Method, string Url, string? Project)>();
        var server = new FakeServer((request, _) =>
        {
            seen.Add((request.Method, request.RequestUri!.PathAndQuery, request.Headers.TryGetValues("X-Wilson-Project", out var project) ? project.Single() : null));
            return FakeServer.Json(HttpStatusCode.OK, "[]");
        });
        using var connection = new Core.Net.ServerConnection("http://wilson.test", new Core.Auth.InMemorySecretStore(), server);
        var reads = connection.AppReadsFor("demo");

        await reads.ListCardsAsync(CancellationToken.None);
        await reads.GetCardAsync("0001", CancellationToken.None);
        await reads.ListBoardColumnsAsync(CancellationToken.None);
        await reads.ListProjectActivityAsync(5, 9, CancellationToken.None);
        await reads.GetProjectStatsAsync(30, CancellationToken.None);

        Assert.All(seen, request =>
        {
            Assert.Equal(HttpMethod.Get, request.Method);
            Assert.Equal("demo", request.Project);
        });
        Assert.Equal(["/api/app-api/v1/cards", "/api/app-api/v1/cards/0001", "/api/app-api/v1/columns", "/api/app-api/v1/activity?limit=5&before=9", "/api/app-api/v1/stats?days=30"], seen.Select(request => request.Url));
    }
}
