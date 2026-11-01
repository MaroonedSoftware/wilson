using MaroonedSoftware.Wilson.Desktop.Core.Auth;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Auth;

public class SignInStepTests
{
    private const string Kept = "http://tower:13101";

    [Fact]
    public void AFirstRunOpensOnTheWelcome() => Assert.Equal(SignInStep.Welcome, SignInSteps.Initial(null));

    [Fact]
    public void ARememberedServerOpensOnThePassword() => Assert.Equal(SignInStep.Password, SignInSteps.Initial(Kept));

    [Theory]
    [InlineData(SignInStep.Code, Kept, SignInStep.Password)]
    [InlineData(SignInStep.Password, Kept, SignInStep.Server)]
    [InlineData(SignInStep.Server, Kept, SignInStep.Password)]
    [InlineData(SignInStep.Server, null, SignInStep.Welcome)]
    [InlineData(SignInStep.Welcome, null, SignInStep.Welcome)]
    public void GoesBackOneStep(SignInStep from, string? kept, SignInStep to) => Assert.Equal(to, SignInSteps.Back(from, kept));
}
