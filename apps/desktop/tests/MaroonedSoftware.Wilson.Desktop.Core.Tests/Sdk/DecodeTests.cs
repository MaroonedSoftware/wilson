using System.Text.Json;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Sdk;

/// <summary>
/// Compiling is one gate and decoding is another: a generator can be happy with a wire name that is
/// wrong. These are real API responses, recorded for the Android tests.
/// </summary>
public class DecodeTests
{
    private static T Read<T>(string name) =>
        JsonSerializer.Deserialize<T>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "api", name)), SdkJson.Options)
        ?? throw new InvalidOperationException($"{name} decoded to nothing");

    [Fact]
    public void Token() => Assert.Equal(TokenResponseResult.Token, Read<TokenResponse>("token.json").Result);

    [Fact]
    public void Session() => Assert.Equal("operator@example.com", Read<CurrentSession>("session.json").Email);

    [Fact]
    public void Projects() => Assert.NotEmpty(Read<List<Project>>("projects.json"));

    [Fact]
    public void Cards() => Assert.NotEmpty(Read<List<CardSummary>>("cards.json"));

    [Fact]
    public void Card() => Assert.NotEmpty(Read<CardDetail>("card.json").Id);

    [Fact]
    public void Columns() => Assert.NotEmpty(Read<BoardColumns>("columns.json").Stages);

    [Fact]
    public void Events() => Assert.NotNull(Read<List<CardEvent>>("events.json"));

    [Fact]
    public void Usage() => Assert.NotNull(Read<CardUsage>("usage.json"));

    [Fact]
    public void Health() => Assert.NotNull(Read<Health>("health.json"));

    [Fact]
    public void Threads() => Assert.NotEmpty(Read<List<ChatThread>>("threads.json"));

    [Fact]
    public void Thread() => Assert.NotEmpty(Read<ChatThread>("thread.json").Id);

    [Fact]
    public void ThreadDetail() => Assert.NotNull(Read<ChatThreadDetail>("thread-detail.json"));
}
