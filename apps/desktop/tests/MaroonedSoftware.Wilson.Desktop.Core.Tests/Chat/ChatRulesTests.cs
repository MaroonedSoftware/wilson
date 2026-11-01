using System.Text.Json;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests.Chat;

public class ChatRulesTests
{
    [Theory]
    [InlineData("All done.", "All done.")]
    [InlineData("All done.\n\n<suggestions>\n- next", "All done.")]
    [InlineData("All done. <SUGGEST", "All done.")]
    [InlineData("a < b holds", "a < b holds")]
    public void TheFollowUpsBlockNeverShows(string draft, string shown) => Assert.Equal(shown, ChatRules.WithoutSuggestions(draft));

    [Theory]
    [InlineData(ChatPendingActionStatus.Pending, 60, true)]
    [InlineData(ChatPendingActionStatus.Pending, -60, false)]
    [InlineData(ChatPendingActionStatus.Done, 60, false)]
    public void OnlyAPendingUnexpiredActionCanBeAnswered(ChatPendingActionStatus status, int seconds, bool expected)
    {
        var action = new ChatPendingAction
        {
            Id = "a",
            ThreadId = "t",
            Operation = "op",
            Arguments = JsonSerializer.SerializeToElement(new { }),
            Summary = "s",
            Status = status,
            ExpiresAt = DateTimeOffset.UnixEpoch.AddSeconds(seconds),
            CreatedAt = DateTimeOffset.UnixEpoch,
        };

        Assert.Equal(expected, ChatRules.IsAwaiting(action, DateTimeOffset.UnixEpoch));
    }
}
