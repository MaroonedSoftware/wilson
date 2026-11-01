using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Planning;

/// <summary>Folding turns into a planning conversation. Pure, so a resume can be replayed in a test.</summary>
public static class PlanTranscript
{
    /// <summary>Folds a turn in by `seq`: one arrives from the stream and from the POST, and must show once.</summary>
    public static IReadOnlyList<PlanTurn> Insert(IEnumerable<PlanTurn> turns, PlanTurn turn)
    {
        ArgumentNullException.ThrowIfNull(turn);

        return [.. turns.Where(held => held.Seq != turn.Seq).Append(turn).OrderBy(held => held.Seq)];
    }

    /// <summary>
    /// Folds in a reply, with the message that asked for it. The stream replays stored turns only on
    /// connecting and the POST answers with the reply alone, so nothing else delivers the person's
    /// own turn. It stored just before the reply, and a later replay of the real one lands on the
    /// same `seq` and replaces this.
    /// </summary>
    public static IReadOnlyList<PlanTurn> WithReply(IReadOnlyList<PlanTurn> turns, PlanTurn reply, string sent)
    {
        ArgumentNullException.ThrowIfNull(turns);
        ArgumentNullException.ThrowIfNull(reply);

        var asked = new PlanTurn { Seq = reply.Seq - 1, Role = PlanTurnRole.User, Content = sent, CreatedAt = reply.CreatedAt };
        return Insert(string.IsNullOrWhiteSpace(sent) || turns.Any(turn => turn.Seq == asked.Seq) ? turns : Insert(turns, asked), reply);
    }
}
