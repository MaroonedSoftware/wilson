using System.Net;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;
using Xunit;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Auth;

public sealed class SignInWordsTests
{
    private static async Task<SdkException> Refusal(HttpStatusCode status, string body)
    {
        using var server = new FakeServer((_, _) => FakeServer.Json(status, body));
        using var connection = new ServerConnection("https://wilson.test", new InMemorySecretStore(), server);
        return await Assert.ThrowsAsync<SdkException>(() => connection.Sdk.Onboarding.CreateAccountAsync(new CreateAccountRequest { Email = "a@b.c", Password = "x" }, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task An_account_that_exists_says_to_sign_in() =>
        Assert.Equal("An account already exists. Go back and sign in.", SignInWords.OfAccount(await Refusal(HttpStatusCode.Conflict, "{}")));

    [Fact]
    public async Task The_password_policy_gives_its_advice() =>
        Assert.Equal(
            "That password is too easy to guess. Common. Add a word.",
            SignInWords.OfAccount(await Refusal(HttpStatusCode.BadRequest, """{"details":{"password":"Common.","suggestions":["Add a word."]}}""")));

    [Fact]
    public async Task The_password_policy_with_no_advice_still_says_so() =>
        Assert.Equal("That password is too easy to guess.", SignInWords.OfAccount(await Refusal(HttpStatusCode.BadRequest, """{"details":{"suggestions":[]}}""")));

    [Fact]
    public async Task Any_other_refusal_is_the_servers_own() =>
        Assert.Equal("no", SignInWords.OfAccount(await Refusal(HttpStatusCode.BadRequest, """{"details":{"reason":"no"}}""")));

    [Fact]
    public async Task A_code_refused_says_to_try_the_next() =>
        Assert.Equal("That code is wrong or has already been used. Try the next one.", SignInWords.OfCode(await Refusal(HttpStatusCode.Unauthorized, "{}")));

    [Theory]
    [InlineData(true, "That code was not accepted. Check your authenticator and try the next one.")]
    [InlineData(false, "Wrong email or password.")]
    public void A_refusal_depends_on_what_was_asked(bool answeringCode, string expected) =>
        Assert.Equal(expected, SignInWords.Of(new SignInResult.Refused(), answeringCode));
}
