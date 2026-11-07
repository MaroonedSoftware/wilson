using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Board;

/// <summary>What a merge came to. Pure, because getting "unknown" right is the point of it.</summary>
public abstract record MergeOutcome
{
    private MergeOutcome()
    {
    }

    public sealed record Landed(string? Commit) : MergeOutcome
    {
        public override string Message => Commit is null ? "Landed on main." : $"Landed on main as {Commit[..Math.Min(8, Commit.Length)]}.";
    }

    /// <summary>The merge opened a GitHub pull request instead of landing: the card follows it when it merges there.</summary>
    public sealed record OpenedPullRequest(long Number) : MergeOutcome
    {
        public override string Message => $"Opened pull request #{Number}. The card moves to merged when it merges on GitHub.";
    }

    public sealed record Refused(string Reason) : MergeOutcome
    {
        public override string Message => Reason;
    }

    /// <summary>The answer never arrived, which says nothing about whether it landed. Never retried.</summary>
    public sealed record Unknown : MergeOutcome
    {
        public override string Message => "The merge's answer was lost, so it may still have landed. Check the card before trying again.";
    }

    public abstract string Message { get; }

    /// <summary>Asks for a merge. Only a server's answer is an answer: anything else is <see cref="Unknown"/>.</summary>
    public static async Task<MergeOutcome> OfAsync(Func<Task<MergeResult>> merge)
    {
        ArgumentNullException.ThrowIfNull(merge);

        try
        {
            var result = await merge().ConfigureAwait(false);
            if (result.Merged)
            {
                return new Landed(result.Commit);
            }

            return result.PullRequest is { State: CardPullRequestState.Open } pullRequest
                ? new OpenedPullRequest(pullRequest.Number)
                : new Refused(result.Reason ?? "The merge was refused.");
        }
        catch (SdkException failure)
        {
            return new Refused(ApiError.Reason(failure));
        }
        catch (Exception failure) when (failure is HttpRequestException or IOException or TaskCanceledException)
        {
            return new Unknown();
        }
    }
}
